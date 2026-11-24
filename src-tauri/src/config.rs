//! Persistenz: `config.json` in `%APPDATA%\Net-Conf\`.
//!
//! Gespeichert werden Daten, die über einen Neustart hinaus bleiben sollen
//! und die das Backend kennen muss: Monitor-Ziele, WoL-Geräte, IP-Profile und
//! „Beim Schliessen in den Tray minimieren“.
//! (Reine Anzeige-Einstellungen wie die Akzentfarbe bleiben im
//! localStorage des WebViews, siehe `src/settings.ts`.)
//!
//! Robustheit:
//! * **Atomares Schreiben:** erst in `config.json.tmp` schreiben, auf die
//!   Platte zwingen (`sync_all`), dann umbenennen. Stürzt die App mitten im
//!   Schreiben ab, bleibt die alte Datei heil.
//! * **Kaputte Datei:** wird als `config.json.bak` gesichert, die App startet
//!   mit Standardwerten und meldet das einmal.
//! * **Prüfung:** Beim Speichern wird alles validiert (Hosts, MACs, Längen),
//!   beim Laden werden ungültige Einträge stillschweigend verworfen.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const MAX_MONITOR_TARGETS: usize = 20;
pub const MAX_WOL_DEVICES: usize = 100;
/// Erlaubte Monitor-Intervalle in Sekunden.
pub const MONITOR_INTERVALS: [u32; 4] = [1, 2, 5, 10];
const FILE_NAME: &str = "config.json";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorTarget {
    pub name: String,
    pub host: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WolDevice {
    pub name: String,
    /// immer im Format "AA-BB-CC-DD-EE-FF" (wird beim Speichern normalisiert)
    pub mac: String,
    /// optional: IPv4, für den Ping-Check nach dem Aufwecken
    #[serde(default)]
    pub ip: Option<String>,
    #[serde(default)]
    pub note: String,
}

/// Der Inhalt von config.json. `default` = fehlende Felder bekommen Standardwerte
/// (so bleiben alte Dateien lesbar, wenn neue Felder dazukommen).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub version: u32,
    pub monitor_targets: Vec<MonitorTarget>,
    pub monitor_interval_sec: u32,
    pub wol_devices: Vec<WolDevice>,
    /// Werkzeuge → IP-Profile (geprüft in `ipprofile::check_profile`)
    pub ip_profiles: Vec<crate::ipprofile::IpProfile>,
    /// Fenster schliessen = in den Tray minimieren (Standard aus)
    pub close_to_tray: bool,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            version: 1,
            monitor_targets: Vec::new(),
            monitor_interval_sec: 2,
            wol_devices: Vec::new(),
            ip_profiles: Vec::new(),
            close_to_tray: false,
        }
    }
}

/// Antwort von `load_config`: die Daten und ggf. ein Hinweis (kaputte Datei).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadResult {
    pub config: Config,
    pub notice: Option<String>,
    /// Pfad der Datei (für die Anzeige in den Einstellungen)
    pub path: String,
}

// ---------------------------------------------------------------------------
// Validierung
// ---------------------------------------------------------------------------

/// Anzeigename: 1–40 Zeichen, keine Steuerzeichen.
pub(crate) fn check_name(raw: &str, what: &str) -> Result<String, String> {
    let s = raw.trim();
    if s.is_empty() {
        return Err(format!("{what}: Bitte einen Namen eingeben."));
    }
    if s.chars().count() > 40 {
        return Err(format!("{what}: Der Name ist zu lang (max. 40 Zeichen)."));
    }
    if s.chars().any(char::is_control) {
        return Err(format!("{what}: Der Name enthält ungültige Zeichen."));
    }
    Ok(s.to_string())
}

fn check_note(raw: &str) -> Result<String, String> {
    let s = raw.trim();
    if s.chars().count() > 120 {
        return Err("Die Notiz ist zu lang (max. 120 Zeichen).".into());
    }
    if s.chars().any(char::is_control) {
        return Err("Die Notiz enthält ungültige Zeichen.".into());
    }
    Ok(s.to_string())
}

pub fn check_monitor_target(t: &MonitorTarget) -> Result<MonitorTarget, String> {
    let host = crate::runner::validate_target(&t.host)?;
    let name = if t.name.trim().is_empty() { host.clone() } else { check_name(&t.name, "Monitor-Ziel")? };
    Ok(MonitorTarget { name, host })
}

pub fn check_wol_device(d: &WolDevice) -> Result<WolDevice, String> {
    let name = check_name(&d.name, "WoL-Gerät")?;
    let mac = crate::wol::format_mac(&crate::wol::parse_mac(&d.mac)?);
    let ip = match d.ip.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => Some(
            s.parse::<std::net::Ipv4Addr>()
                .map_err(|_| format!("„{s}“ ist keine gültige IPv4-Adresse."))?
                .to_string(),
        ),
        None => None,
    };
    Ok(WolDevice { name, mac, ip, note: check_note(&d.note)? })
}

/// Strenge Prüfung beim Speichern: Fehler → Meldung an den Benutzer.
pub fn validate(cfg: &Config) -> Result<Config, String> {
    if cfg.monitor_targets.len() > MAX_MONITOR_TARGETS {
        return Err(format!("Höchstens {MAX_MONITOR_TARGETS} Monitor-Ziele."));
    }
    if cfg.wol_devices.len() > MAX_WOL_DEVICES {
        return Err(format!("Höchstens {MAX_WOL_DEVICES} WoL-Geräte."));
    }
    if !MONITOR_INTERVALS.contains(&cfg.monitor_interval_sec) {
        return Err("Ungültiges Intervall (erlaubt: 1, 2, 5, 10 s).".into());
    }
    if cfg.ip_profiles.len() > crate::ipprofile::MAX_PROFILES {
        return Err(format!("Höchstens {} IP-Profile.", crate::ipprofile::MAX_PROFILES));
    }
    let ip_profiles: Vec<_> = cfg.ip_profiles.iter().map(crate::ipprofile::check_profile).collect::<Result<_, _>>()?;
    for (i, p) in ip_profiles.iter().enumerate() {
        if ip_profiles[..i].iter().any(|q| q.name.to_lowercase() == p.name.to_lowercase()) {
            return Err(format!("Es gibt schon ein IP-Profil „{}“.", p.name));
        }
    }
    Ok(Config {
        version: 1,
        monitor_targets: cfg.monitor_targets.iter().map(check_monitor_target).collect::<Result<_, _>>()?,
        monitor_interval_sec: cfg.monitor_interval_sec,
        wol_devices: cfg.wol_devices.iter().map(check_wol_device).collect::<Result<_, _>>()?,
        ip_profiles,
        close_to_tray: cfg.close_to_tray,
    })
}

/// Milde Prüfung beim Laden: Ungültiges wird verworfen statt abgelehnt
/// (z. B. wenn jemand die Datei von Hand bearbeitet hat).
fn sanitize(cfg: Config) -> Config {
    Config {
        version: 1,
        monitor_targets: cfg
            .monitor_targets
            .iter()
            .filter_map(|t| check_monitor_target(t).ok())
            .take(MAX_MONITOR_TARGETS)
            .collect(),
        monitor_interval_sec: if MONITOR_INTERVALS.contains(&cfg.monitor_interval_sec) {
            cfg.monitor_interval_sec
        } else {
            Config::default().monitor_interval_sec
        },
        wol_devices: cfg.wol_devices.iter().filter_map(|d| check_wol_device(d).ok()).take(MAX_WOL_DEVICES).collect(),
        ip_profiles: {
            let mut list: Vec<crate::ipprofile::IpProfile> = Vec::new();
            for p in cfg.ip_profiles.iter().filter_map(|p| crate::ipprofile::check_profile(p).ok()) {
                // doppelte Namen: der erste gewinnt
                if list.len() < crate::ipprofile::MAX_PROFILES
                    && !list.iter().any(|q| q.name.to_lowercase() == p.name.to_lowercase())
                {
                    list.push(p);
                }
            }
            list
        },
        close_to_tray: cfg.close_to_tray,
    }
}

// ---------------------------------------------------------------------------
// Datei lesen / schreiben
// ---------------------------------------------------------------------------

/// Ordner der Konfiguration: %APPDATA%\Net-Conf (Windows),
/// sonst $XDG_CONFIG_HOME/net-conf bzw. ~/.config/net-conf.
pub fn config_dir() -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        let appdata = std::env::var_os("APPDATA").ok_or("Der Ordner %APPDATA% ist unbekannt.")?;
        Ok(PathBuf::from(appdata).join("Net-Conf"))
    }
    #[cfg(not(windows))]
    {
        if let Some(x) = std::env::var_os("XDG_CONFIG_HOME") {
            return Ok(PathBuf::from(x).join("net-conf"));
        }
        let home = std::env::var_os("HOME").ok_or("Der Home-Ordner ist unbekannt.")?;
        Ok(PathBuf::from(home).join(".config").join("net-conf"))
    }
}

/// Nur ein Schreib-/Lesevorgang gleichzeitig (z. B. zwei schnelle Klicks).
static FILE_LOCK: Mutex<()> = Mutex::new(());

pub fn load_from(dir: &Path) -> LoadResult {
    let _guard = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = dir.join(FILE_NAME);
    let shown = path.display().to_string();
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        // Noch nie gespeichert → Standardwerte, ohne Hinweis
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return LoadResult { config: Config::default(), notice: None, path: shown }
        }
        Err(e) => {
            return LoadResult {
                config: Config::default(),
                notice: Some(format!("config.json konnte nicht gelesen werden ({e}) – Standardwerte aktiv.")),
                path: shown,
            }
        }
    };
    match serde_json::from_str::<Config>(&text) {
        Ok(cfg) => LoadResult { config: sanitize(cfg), notice: None, path: shown },
        Err(_) => {
            // Kaputte Datei sichern, damit nichts verloren geht.
            let bak = dir.join(format!("{FILE_NAME}.bak"));
            let saved = std::fs::copy(&path, &bak).is_ok();
            LoadResult {
                config: Config::default(),
                notice: Some(if saved {
                    "config.json war beschädigt – Sicherung als config.json.bak angelegt, Standardwerte aktiv.".into()
                } else {
                    "config.json war beschädigt – Standardwerte aktiv.".into()
                }),
                path: shown,
            }
        }
    }
}

pub fn save_to(dir: &Path, cfg: &Config) -> Result<Config, String> {
    use std::io::Write;
    let clean = validate(cfg)?;
    let _guard = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    std::fs::create_dir_all(dir).map_err(|e| format!("Ordner {} konnte nicht angelegt werden: {e}", dir.display()))?;
    let json = serde_json::to_string_pretty(&clean).map_err(|e| format!("Interner Fehler: {e}"))?;
    let tmp = dir.join(format!("{FILE_NAME}.tmp"));
    let target = dir.join(FILE_NAME);
    let write = || -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(json.as_bytes())?;
        f.sync_all()?; // wirklich auf die Platte, bevor umbenannt wird
        drop(f);
        // Unter Windows ersetzt rename eine vorhandene Datei (MoveFileExW mit REPLACE_EXISTING).
        std::fs::rename(&tmp, &target)
    };
    write().map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("config.json konnte nicht gespeichert werden: {e}")
    })?;
    Ok(clean)
}

// ---------------------------------------------------------------------------
// Tauri-Commands
// ---------------------------------------------------------------------------

pub fn load() -> LoadResult {
    match config_dir() {
        Ok(dir) => load_from(&dir),
        Err(e) => LoadResult { config: Config::default(), notice: Some(e), path: String::new() },
    }
}

pub fn save(cfg: &Config) -> Result<Config, String> {
    save_to(&config_dir()?, cfg)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let d = std::env::temp_dir().join(format!("netconf-test-{name}-{nanos}"));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn sample() -> Config {
        Config {
            version: 1,
            monitor_targets: vec![MonitorTarget { name: "Router".into(), host: "192.168.1.1".into() }],
            monitor_interval_sec: 5,
            wol_devices: vec![WolDevice {
                name: "NAS".into(),
                mac: "aa:bb:cc:01:02:03".into(),
                ip: Some("192.168.1.20".into()),
                note: "Keller".into(),
            }],
            ip_profiles: vec![crate::ipprofile::IpProfile {
                name: "Labor".into(),
                adapter: "Ethernet".into(),
                mac: "10-22-33-44-55-66".into(),
                mode: crate::ipprofile::ProfileMode::Static,
                ipv4: "10.0.0.20".into(),
                subnet: "/24".into(),
                gateway: "10.0.0.1".into(),
                dns1: "10.0.0.1".into(),
                dns2: String::new(),
            }],
            close_to_tray: true,
        }
    }

    #[test]
    fn speichern_und_laden() {
        let dir = temp_dir("roundtrip");
        let saved = save_to(&dir, &sample()).unwrap();
        assert_eq!(saved.wol_devices[0].mac, "AA-BB-CC-01-02-03", "MAC wird normalisiert");
        assert_eq!(saved.ip_profiles[0].subnet, "255.255.255.0", "Maske wird normalisiert");
        assert!(saved.close_to_tray);
        assert!(!dir.join("config.json.tmp").exists(), "keine Temp-Datei übrig");
        let loaded = load_from(&dir);
        assert_eq!(loaded.config, saved);
        assert!(loaded.notice.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn fehlende_datei_gibt_standard() {
        let dir = temp_dir("missing");
        let r = load_from(&dir);
        assert_eq!(r.config, Config::default());
        assert!(r.notice.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn kaputte_datei_wird_gesichert() {
        let dir = temp_dir("broken");
        std::fs::write(dir.join("config.json"), "{ das ist kein json").unwrap();
        let r = load_from(&dir);
        assert_eq!(r.config, Config::default());
        assert!(r.notice.unwrap().contains(".bak"));
        assert_eq!(std::fs::read_to_string(dir.join("config.json.bak")).unwrap(), "{ das ist kein json");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ungueltige_eintraege_beim_laden_verwerfen() {
        let dir = temp_dir("sanitize");
        let json = r#"{"monitorTargets":[{"name":"ok","host":"1.1.1.1"},{"name":"böse","host":"1.1.1.1 & calc"}],
                      "monitorIntervalSec":7,
                      "wolDevices":[{"name":"x","mac":"zz"}],
                      "ipProfiles":[{"name":"ok","adapter":"LAN","mode":"dhcp"},
                                    {"name":"böse","adapter":"LAN","mode":"static","ipv4":"10.0.0.0","subnet":"/24"}],
                      "unbekanntesFeld":true}"#;
        std::fs::write(dir.join("config.json"), json).unwrap();
        let r = load_from(&dir);
        assert_eq!(r.config.monitor_targets.len(), 1);
        assert_eq!(r.config.monitor_interval_sec, 2);
        assert!(r.config.wol_devices.is_empty());
        assert_eq!(r.config.ip_profiles.len(), 1, "Profil mit Netzadresse verworfen");
        assert!(!r.config.close_to_tray, "fehlendes Feld = Standard");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn speichern_prueft_streng() {
        let dir = temp_dir("strict");
        let mut c = sample();
        c.monitor_targets[0].host = "-t".into();
        assert!(save_to(&dir, &c).is_err());
        let mut c = sample();
        c.wol_devices[0].mac = "12345".into();
        assert!(save_to(&dir, &c).is_err());
        let mut c = sample();
        c.wol_devices[0].ip = Some("999.1.1.1".into());
        assert!(save_to(&dir, &c).is_err());
        let mut c = sample();
        c.monitor_interval_sec = 3;
        assert!(save_to(&dir, &c).is_err());
        let mut c = sample();
        c.ip_profiles[0].gateway = "10.0.1.1".into(); // ausserhalb des Subnetzes
        assert!(save_to(&dir, &c).is_err());
        let mut c = sample();
        let mut dup = c.ip_profiles[0].clone();
        dup.name = "LABOR".into();
        c.ip_profiles.push(dup);
        assert!(save_to(&dir, &c).is_err(), "doppelter Name");
        let mut c = sample();
        c.monitor_targets = (0..21).map(|i| MonitorTarget { name: format!("t{i}"), host: "1.1.1.1".into() }).collect();
        assert!(save_to(&dir, &c).is_err());
        assert!(!dir.join("config.json").exists(), "nichts geschrieben");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
