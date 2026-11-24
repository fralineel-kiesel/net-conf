//! IP-Profile (Werkzeuge → IP-Profile): einen Adapter per netsh auf DHCP oder
//! eine feste (statische) IPv4-Konfiguration umstellen – mit Sicherheitsnetz.
//!
//! Sicherheit:
//! * Das Frontend schickt nur den **Profilnamen**. Das Profil selbst liest das
//!   Backend aus `config.json` und prüft es dort noch einmal streng.
//! * Der Adapter wird über die gespeicherte **MAC** in der aktuellen
//!   Adapterliste gesucht (bei leerer MAC über den exakten Namen). Der Name,
//!   der an netsh geht, stammt also immer aus der echten Windows-Liste.
//! * netsh-Argumente als Liste, Adaptername als eigenes Argument in der
//!   Positionsform (gleiche Begründung wie bei „Adapter neu starten“, siehe
//!   `actions.rs`). Keine Shell dazwischen.
//!
//! Sicherheitsnetz (wie bei der Windows-Bildschirmauflösung):
//! 1. Vor der Änderung wird die aktuelle Konfiguration gesichert (Adresse,
//!    Maske, Gateway, DNS; ob DNS statisch ist, steht in der Registry).
//! 2. Nach dem Anwenden läuft ein Countdown von 30 s. Nur mit „Behalten“
//!    bleibt die neue Konfiguration.
//! 3. Ohne Bestätigung (oder wenn ein Schritt scheitert, oder die App beendet
//!    wird) stellt das **Backend selbst** die gesicherte Konfiguration wieder
//!    her – auch wenn die Oberfläche hängt.

use crate::adapters::AdapterInfo;
use crate::runner::{run_plan_blocking, Plan, Step};
use serde::{Deserialize, Serialize};
use std::net::Ipv4Addr;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

pub const MAX_PROFILES: usize = 50;
/// So lange hat man Zeit für „Behalten“.
pub const CONFIRM_SECS: u64 = 30;

// ---------------------------------------------------------------------------
// Gespeichertes Profil (config.json)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProfileMode {
    Dhcp,
    Static,
}

/// Ein IP-Profil, so wie es in config.json steht. Leere Strings = „nicht gesetzt“.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IpProfile {
    pub name: String,
    /// Adaptername beim Speichern (Anzeige; gesucht wird über die MAC)
    pub adapter: String,
    /// "AA-BB-CC-DD-EE-FF" zur Wiedererkennung (leer, falls der Adapter keine hat)
    #[serde(default)]
    pub mac: String,
    pub mode: ProfileMode,
    #[serde(default)]
    pub ipv4: String,
    /// Subnetzmaske; Eingabe auch als "/24" oder "24", gespeichert als "255.255.255.0"
    #[serde(default)]
    pub subnet: String,
    #[serde(default)]
    pub gateway: String,
    #[serde(default)]
    pub dns1: String,
    #[serde(default)]
    pub dns2: String,
}

// ---------------------------------------------------------------------------
// Geprüfte, interne Darstellung
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AddrConfig {
    Dhcp,
    Static { ip: Ipv4Addr, mask: Ipv4Addr, gateway: Option<Ipv4Addr> },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DnsConfig {
    /// DNS-Server vom DHCP-Server
    Dhcp,
    /// Feste DNS-Server (leer = keine)
    Static(Vec<Ipv4Addr>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetConfig {
    pub addr: AddrConfig,
    pub dns: DnsConfig,
}

// ---------------------------------------------------------------------------
// Prüfungen (rein, getestet)
// ---------------------------------------------------------------------------

fn parse_ip(raw: &str, what: &str) -> Result<Ipv4Addr, String> {
    let s = raw.trim();
    // Rusts Parser lehnt auch führende Nullen ("010.1.1.1") ab – gut so,
    // Windows würde die sonst evtl. oktal lesen.
    s.parse::<Ipv4Addr>().map_err(|_| format!("{what}: „{s}“ ist keine gültige IPv4-Adresse."))
}

/// Präfix → Maske (0 → 0.0.0.0). `<< 32` wäre in Rust ein Überlauf, daher die Abfrage.
pub fn prefix_to_mask(prefix: u8) -> Ipv4Addr {
    let bits: u32 = if prefix == 0 { 0 } else { u32::MAX << (32 - u32::from(prefix.min(32))) };
    Ipv4Addr::from(bits)
}

/// Subnetzmaske prüfen: "255.255.255.0", "/24" oder "24".
/// Die Einsen müssen zusammenhängen (keine Lücken wie 255.0.255.0), Präfix 1–32.
pub fn parse_mask(raw: &str) -> Result<(Ipv4Addr, u8), String> {
    let s = raw.trim();
    let digits = s.strip_prefix('/').unwrap_or(s);
    if !digits.is_empty() && digits.len() <= 2 && digits.chars().all(|c| c.is_ascii_digit()) {
        let p: u8 = digits.parse().map_err(|_| "Ungültiges Präfix.".to_string())?;
        if !(1..=32).contains(&p) {
            return Err(format!("Präfix /{p} ist ungültig (erlaubt: /1 bis /32)."));
        }
        return Ok((prefix_to_mask(p), p));
    }
    let mask = parse_ip(s, "Subnetzmaske")?;
    let bits = u32::from(mask);
    // Zusammenhängend: invertiert muss es die Form 0…01…1 haben (also 2^k - 1).
    let inv = !bits;
    if inv & inv.wrapping_add(1) != 0 {
        return Err(format!("Subnetzmaske {mask} ist nicht zusammenhängend (z. B. 255.255.255.0 verwenden)."));
    }
    let prefix = bits.count_ones() as u8;
    if prefix == 0 {
        return Err("Subnetzmaske 0.0.0.0 ist ungültig.".into());
    }
    Ok((mask, prefix))
}

/// Grundsätzlich unbrauchbare Adressen (für Host, Gateway und DNS).
fn special_reason(ip: Ipv4Addr) -> Option<&'static str> {
    let o = ip.octets();
    if ip.is_unspecified() || o[0] == 0 {
        Some("ist keine gültige Host-Adresse (0.x.x.x)")
    } else if ip.is_broadcast() {
        Some("ist die Broadcast-Adresse")
    } else if ip.is_multicast() {
        Some("ist eine Multicast-Adresse")
    } else if o[0] >= 240 {
        Some("liegt im reservierten Bereich 240.0.0.0/4")
    } else {
        None
    }
}

fn network_of(ip: Ipv4Addr, mask: Ipv4Addr) -> Ipv4Addr {
    Ipv4Addr::from(u32::from(ip) & u32::from(mask))
}

fn broadcast_of(ip: Ipv4Addr, mask: Ipv4Addr) -> Ipv4Addr {
    Ipv4Addr::from(u32::from(ip) | !u32::from(mask))
}

/// Adresse als Host in diesem Netz erlaubt? (Bei /31 und /32 gibt es keine
/// Netz-/Broadcast-Adresse, RFC 3021.)
fn check_host(ip: Ipv4Addr, mask: Ipv4Addr, what: &str) -> Result<(), String> {
    if let Some(r) = special_reason(ip) {
        return Err(format!("{what}: {ip} {r}."));
    }
    if ip.is_loopback() {
        return Err(format!("{what}: {ip} ist eine Loopback-Adresse."));
    }
    let prefix = u32::from(mask).count_ones();
    if prefix <= 30 {
        if ip == network_of(ip, mask) {
            return Err(format!("{what}: {ip} ist die Netzadresse dieses Subnetzes."));
        }
        if ip == broadcast_of(ip, mask) {
            return Err(format!("{what}: {ip} ist die Broadcast-Adresse dieses Subnetzes."));
        }
    }
    Ok(())
}

fn check_dns(raw: &str, what: &str) -> Result<Ipv4Addr, String> {
    let ip = parse_ip(raw, what)?;
    if let Some(r) = special_reason(ip) {
        return Err(format!("{what}: {ip} {r}."));
    }
    Ok(ip) // 127.0.0.1 ist erlaubt (lokaler DNS, z. B. Pi-hole/dnscrypt)
}

/// Profil streng prüfen und normalisieren (Maske immer als "255.255.255.0").
pub fn check_profile(p: &IpProfile) -> Result<IpProfile, String> {
    let name = crate::config::check_name(&p.name, "IP-Profil")?;
    crate::runner::validate_adapter_chars(&p.adapter)
        .map_err(|_| format!("IP-Profil „{name}“: ungültiger Adaptername."))?;
    let mac = if p.mac.trim().is_empty() {
        String::new()
    } else {
        crate::wol::format_mac(&crate::wol::parse_mac(&p.mac)?)
    };
    let mut out = IpProfile { name, adapter: p.adapter.clone(), mac, ..p.clone() };
    let net = to_net_config(p)?;
    match &net.addr {
        AddrConfig::Dhcp => {
            out.ipv4.clear();
            out.subnet.clear();
            out.gateway.clear();
        }
        AddrConfig::Static { ip, mask, gateway } => {
            out.ipv4 = ip.to_string();
            out.subnet = mask.to_string();
            out.gateway = gateway.map(|g| g.to_string()).unwrap_or_default();
        }
    }
    let dns = match &net.dns {
        DnsConfig::Dhcp => Vec::new(),
        DnsConfig::Static(list) => list.iter().map(Ipv4Addr::to_string).collect(),
    };
    out.dns1 = dns.first().cloned().unwrap_or_default();
    out.dns2 = dns.get(1).cloned().unwrap_or_default();
    Ok(out)
}

/// Profil → Zielkonfiguration (mit allen Prüfungen).
pub fn to_net_config(p: &IpProfile) -> Result<NetConfig, String> {
    let addr = match p.mode {
        ProfileMode::Dhcp => AddrConfig::Dhcp,
        ProfileMode::Static => {
            if p.ipv4.trim().is_empty() {
                return Err("Bitte eine IPv4-Adresse eingeben.".into());
            }
            if p.subnet.trim().is_empty() {
                return Err("Bitte eine Subnetzmaske oder ein Präfix eingeben (z. B. 255.255.255.0 oder /24).".into());
            }
            let ip = parse_ip(&p.ipv4, "IPv4")?;
            let (mask, _) = parse_mask(&p.subnet)?;
            check_host(ip, mask, "IPv4")?;
            let gateway = if p.gateway.trim().is_empty() {
                None
            } else {
                let gw = parse_ip(&p.gateway, "Gateway")?;
                check_host(gw, mask, "Gateway")?;
                if network_of(gw, mask) != network_of(ip, mask) {
                    return Err(format!(
                        "Gateway {gw} liegt nicht im Subnetz {}/{} der IP-Adresse.",
                        network_of(ip, mask),
                        u32::from(mask).count_ones()
                    ));
                }
                if gw == ip {
                    return Err("Das Gateway darf nicht die eigene IP-Adresse sein.".into());
                }
                Some(gw)
            };
            AddrConfig::Static { ip, mask, gateway }
        }
    };
    let d1 = p.dns1.trim();
    let d2 = p.dns2.trim();
    if d1.is_empty() && !d2.is_empty() {
        return Err("DNS 2 ist nur zusammen mit DNS 1 möglich.".into());
    }
    let dns = if d1.is_empty() && p.mode == ProfileMode::Dhcp {
        DnsConfig::Dhcp // DHCP ohne eigene DNS-Server: DNS kommt ebenfalls per DHCP
    } else {
        let mut list = Vec::new();
        if !d1.is_empty() {
            list.push(check_dns(d1, "DNS 1")?);
        }
        if !d2.is_empty() {
            let x = check_dns(d2, "DNS 2")?;
            if list.contains(&x) {
                return Err("DNS 1 und DNS 2 sind gleich.".into());
            }
            list.push(x);
        }
        DnsConfig::Static(list)
    };
    Ok(NetConfig { addr, dns })
}

// ---------------------------------------------------------------------------
// Adapter finden und aktuelle Konfiguration lesen
// ---------------------------------------------------------------------------

/// Adapter zum Profil suchen: über die MAC (Name kann sich geändert haben).
/// Haben mehrere Adapter dieselbe MAC (z. B. Hyper-V-Switch), entscheidet der Name.
pub fn resolve_adapter<'a>(p: &IpProfile, list: &'a [AdapterInfo]) -> Result<&'a AdapterInfo, String> {
    if p.mac.is_empty() {
        return list
            .iter()
            .find(|a| a.name == p.adapter)
            .ok_or_else(|| format!("Adapter „{}“ wurde nicht gefunden.", p.adapter));
    }
    let same_mac: Vec<&AdapterInfo> = list.iter().filter(|a| a.mac.eq_ignore_ascii_case(&p.mac)).collect();
    match same_mac.len() {
        0 => Err(format!(
            "Kein Adapter mit der MAC {} gefunden (Profil gehört zu „{}“). Ist der Adapter angeschlossen bzw. aktiviert?",
            p.mac, p.adapter
        )),
        1 => Ok(same_mac[0]),
        _ => same_mac.into_iter().find(|a| a.name == p.adapter).ok_or_else(|| {
            format!("Mehrere Adapter haben die MAC {} – bitte das Profil neu vom richtigen Adapter übernehmen.", p.mac)
        }),
    }
}

/// Aktuelle Konfiguration eines Adapters (für die Sicherung).
/// `dns_static`: aus der Registry (None = unbekannt → Schätzung über DHCP).
/// Liefert zusätzlich Hinweise, was NICHT gesichert werden kann.
pub fn current_config(a: &AdapterInfo, dns_static: Option<bool>) -> Result<(NetConfig, Vec<String>), String> {
    let mut notes = Vec::new();
    let addr = if a.dhcp_enabled {
        AddrConfig::Dhcp
    } else {
        let first = a.ipv4.first().ok_or_else(|| {
            format!("„{}“ hat eine feste Konfiguration ohne IPv4-Adresse – sie kann nicht gesichert werden.", a.name)
        })?;
        if a.ipv4.len() > 1 {
            notes.push(format!(
                "„{}“ hat {} IPv4-Adressen – gesichert wird nur die erste ({}).",
                a.name,
                a.ipv4.len(),
                first.address
            ));
        }
        let ip = parse_ip(&first.address, "Aktuelle IPv4")?;
        let (mask, _) = parse_mask(&first.subnet_mask)?;
        let gateways: Vec<Ipv4Addr> = a.gateways.iter().filter_map(|g| g.parse().ok()).collect();
        if gateways.len() > 1 {
            notes.push("Mehrere IPv4-Gateways – gesichert wird nur das erste.".into());
        }
        AddrConfig::Static { ip, mask, gateway: gateways.first().copied() }
    };
    let servers: Vec<Ipv4Addr> = a.dns_servers.iter().filter_map(|d| d.parse().ok()).collect();
    let is_static = dns_static.unwrap_or(!a.dhcp_enabled);
    let dns = if is_static {
        if servers.len() > 2 {
            notes.push(format!("{} DNS-Server eingetragen – gesichert werden nur die ersten zwei.", servers.len()));
        }
        DnsConfig::Static(servers.into_iter().take(2).collect())
    } else {
        DnsConfig::Dhcp
    };
    Ok((NetConfig { addr, dns }, notes))
}

// ---------------------------------------------------------------------------
// netsh-Schritte (rein, getestet)
// ---------------------------------------------------------------------------

fn netsh(args: Vec<String>) -> Step {
    Step::run_args("netsh", args)
}

fn s(x: impl ToString) -> String {
    x.to_string()
}

/// Schritte, um `adapter` von `from` nach `to` umzustellen. Unveränderte Teile
/// werden übersprungen – das ist wichtig, denn `set address … dhcp` meldet
/// einen Fehler, wenn DHCP schon aktiv ist.
pub fn build_steps(adapter: &str, from: &NetConfig, to: &NetConfig) -> Vec<Step> {
    let base = |verb: &str, what: &str| vec![s("interface"), s("ipv4"), s(verb), s(what), s(adapter)];
    let mut steps = Vec::new();
    if from.addr != to.addr {
        match &to.addr {
            AddrConfig::Dhcp => {
                let mut a = base("set", "address");
                a.push(s("dhcp"));
                steps.push(netsh(a));
            }
            AddrConfig::Static { ip, mask, gateway } => {
                // netsh interface ipv4 set address "<Name>" static <IP> <Maske> <Gateway>|gateway=none
                let mut a = base("set", "address");
                a.extend([s("static"), s(ip), s(mask)]);
                a.push(gateway.map_or_else(|| s("gateway=none"), s));
                steps.push(netsh(a));
            }
        }
    }
    if from.dns != to.dns {
        match &to.dns {
            DnsConfig::Dhcp => {
                let mut a = base("set", "dnsservers");
                a.push(s("dhcp"));
                steps.push(netsh(a));
            }
            DnsConfig::Static(list) if list.is_empty() => {
                let mut a = base("set", "dnsservers");
                a.extend([s("static"), s("none")]);
                steps.push(netsh(a));
            }
            DnsConfig::Static(list) => {
                // validate=no: netsh soll nicht erst versuchen, den Server zu erreichen
                let mut a = base("set", "dnsservers");
                a.extend([s("static"), s(list[0]), s("primary"), s("validate=no")]);
                steps.push(netsh(a));
                for (i, d) in list.iter().enumerate().skip(1) {
                    let mut a = base("add", "dnsservers");
                    a.extend([s(d), format!("index={}", i + 1), s("validate=no")]);
                    steps.push(netsh(a));
                }
            }
        }
    }
    steps
}

/// Kurzbeschreibung für Dialog und Statusleiste.
pub fn describe(c: &NetConfig) -> String {
    let addr = match &c.addr {
        AddrConfig::Dhcp => "DHCP".to_string(),
        AddrConfig::Static { ip, mask, gateway } => {
            let gw = gateway.map_or_else(|| "kein Gateway".to_string(), |g| format!("Gateway {g}"));
            format!("statisch {ip}/{}, {gw}", u32::from(*mask).count_ones())
        }
    };
    let dns = match &c.dns {
        DnsConfig::Dhcp => "DNS automatisch".to_string(),
        DnsConfig::Static(l) if l.is_empty() => "kein DNS".to_string(),
        DnsConfig::Static(l) => format!("DNS {}", l.iter().map(Ipv4Addr::to_string).collect::<Vec<_>>().join(", ")),
    };
    format!("{addr}, {dns}")
}

// ---------------------------------------------------------------------------
// Registry: Ist DNS fest eingetragen? (nur Windows)
// ---------------------------------------------------------------------------

/// Unter `…\Tcpip\Parameters\Interfaces\{GUID}` steht `NameServer` nur bei fest
/// eingetragenen DNS-Servern (vom DHCP kommt `DhcpNameServer`). Lesen geht ohne Admin.
#[cfg(windows)]
fn read_dns_static(guid: &str) -> Option<bool> {
    // Die GUID kommt aus der Adapterliste – trotzdem nur erwartete Zeichen zulassen.
    if guid.is_empty() || !guid.chars().all(|c| c.is_ascii_hexdigit() || matches!(c, '{' | '}' | '-')) {
        return None;
    }
    let path = format!(r"SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces\{guid}");
    match crate::winreg::read_string(crate::winreg::Root::LocalMachine, &path, "NameServer") {
        Ok(Some(v)) => Some(!v.trim().is_empty()),
        Ok(None) => Some(false),
        Err(_) => None,
    }
}

#[cfg(not(windows))]
fn read_dns_static(_guid: &str) -> Option<bool> {
    None
}

// ---------------------------------------------------------------------------
// Ablauf mit Sicherheitsnetz (Tauri-State + Commands)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Decision {
    Keep,
    Revert,
}

#[derive(Default)]
struct GuardState {
    /// Läuft gerade eine Änderung (inkl. Countdown/Wiederherstellung)?
    busy: bool,
    /// Wartet der Countdown gerade auf „Behalten“?
    pending: bool,
    decision: Option<Decision>,
}

/// Tauri-State: höchstens eine IP-Änderung gleichzeitig.
#[derive(Default)]
pub struct IpGuard {
    state: Mutex<GuardState>,
    cv: Condvar,
}

impl IpGuard {
    fn lock(&self) -> MutexGuard<'_, GuardState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn decide(&self, d: Decision) -> bool {
        let mut st = self.lock();
        if !st.busy {
            return false;
        }
        st.decision = Some(d);
        self.cv.notify_all();
        true
    }

    /// Beim Beenden der App: offene Änderung zurücknehmen und warten, bis die
    /// Wiederherstellung durch ist (max. 40 s).
    pub fn revert_and_wait(&self) {
        let mut st = self.lock();
        if !st.busy {
            return;
        }
        if st.decision.is_none() {
            st.decision = Some(Decision::Revert);
        }
        self.cv.notify_all();
        let end = Instant::now() + Duration::from_secs(40);
        while st.busy {
            let left = end.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            st = self.cv.wait_timeout(st, left).unwrap_or_else(|e| e.into_inner()).0;
        }
    }
}

/// Vorschau für den Bestätigungsdialog.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub profile: String,
    pub adapter: String,
    pub mac: String,
    pub from: String,
    pub to: String,
    /// netsh-Befehle, die ausgeführt werden
    pub commands: Vec<String>,
    pub notes: Vec<String>,
}

/// Event "ip-profile": Zustand des Sicherheitsnetzes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileEvent {
    /// "pending" | "kept" | "reverting" | "reverted" | "failed"
    phase: &'static str,
    seconds: Option<u64>,
    message: String,
    ok: bool,
}

fn emit(app: &AppHandle, phase: &'static str, seconds: Option<u64>, message: String, ok: bool) {
    let _ = app.emit("ip-profile", ProfileEvent { phase, seconds, message, ok });
}

/// Alles, was für Vorschau und Anwenden vorab ermittelt wird.
struct Prepared {
    adapter: AdapterInfo,
    from: NetConfig,
    to: NetConfig,
    steps: Vec<Step>,
    notes: Vec<String>,
    profile: IpProfile,
}

fn prepare(name: &str) -> Result<Prepared, String> {
    let cfg = crate::config::load();
    let stored = cfg
        .config
        .ip_profiles
        .iter()
        .find(|p| p.name == name)
        .ok_or_else(|| format!("IP-Profil „{name}“ wurde nicht gefunden (zuerst speichern)."))?;
    let profile = check_profile(stored)?;
    let to = to_net_config(&profile)?;
    let list = crate::adapters::list_adapters()?;
    let adapter = resolve_adapter(&profile, &list)?.clone();
    crate::runner::validate_adapter_chars(&adapter.name)?;
    let (from, notes) = current_config(&adapter, read_dns_static(&adapter.id))?;
    let steps = build_steps(&adapter.name, &from, &to);
    if steps.is_empty() {
        return Err(format!("„{}“ hat bereits genau diese Konfiguration – nichts zu tun.", adapter.name));
    }
    Ok(Prepared { adapter, from, to, steps, notes, profile })
}

#[tauri::command]
pub async fn ip_profile_preview(name: String) -> Result<Preview, String> {
    let p = prepare(&name)?;
    Ok(Preview {
        profile: p.profile.name,
        mac: p.adapter.mac.clone(),
        adapter: p.adapter.name.clone(),
        from: describe(&p.from),
        to: describe(&p.to),
        commands: p.steps.iter().map(Step::label).collect(),
        notes: p.notes,
    })
}

/// Eigene runIds für die Wiederherstellung (das Frontend nutzt kleinere Zahlen
/// bzw. 0xF000_0000+ für logToConsole).
static RESTORE_ID: AtomicU32 = AtomicU32::new(0xE000_0000);

/// Profil anwenden. Kehrt sofort zurück; der Rest läuft im Hintergrund und
/// meldet sich über `cmd-*` (Konsole) und `ip-profile` (Countdown, Ergebnis).
#[tauri::command]
pub async fn ip_profile_apply(app: AppHandle, guard: State<'_, IpGuard>, run_id: u32, name: String) -> Result<(), String> {
    if !crate::system::is_admin() {
        return Err("Zum Anwenden eines IP-Profils werden Administratorrechte benötigt.".into());
    }
    let prep = prepare(&name)?;
    {
        let mut st = guard.lock();
        if st.busy {
            return Err("Es läuft bereits eine IP-Änderung.".into());
        }
        st.busy = true;
        st.pending = false;
        st.decision = None;
    }
    let plan = Plan {
        title: format!("IP-Profil „{}“ anwenden – Adapter \"{}\"", prep.profile.name, prep.adapter.name),
        steps: prep.steps.clone(),
    };
    std::thread::spawn(move || {
        use tauri::Manager;
        let guard = app.state::<IpGuard>();
        flow(&app, &guard, run_id, plan, &prep);
        let mut st = guard.lock();
        st.busy = false;
        st.pending = false;
        st.decision = None;
        guard.cv.notify_all();
    });
    Ok(())
}

/// Der eigentliche Ablauf (läuft im eigenen Thread).
fn flow(app: &AppHandle, guard: &IpGuard, run_id: u32, plan: Plan, prep: &Prepared) {
    let result = match run_plan_blocking(app, run_id, plan) {
        Ok(r) => r,
        Err(e) => {
            // Nichts wurde geändert (z. B. netsh nicht gefunden)
            emit(app, "failed", None, e, false);
            return;
        }
    };
    if !result.ok() {
        emit(app, "reverting", None, "Anwenden fehlgeschlagen – vorherige Konfiguration wird wiederhergestellt …".into(), false);
        let (ok, msg) = revert(app, prep);
        let text = if ok { format!("Anwenden fehlgeschlagen – {msg}") } else { msg };
        emit(app, "reverted", None, text, false);
        return;
    }

    // Countdown: auf „Behalten“ / „Zurücksetzen“ warten, höchstens CONFIRM_SECS.
    emit(app, "pending", Some(CONFIRM_SECS), describe(&prep.to), true);
    let decision = {
        let mut st = guard.lock();
        st.pending = true;
        let end = Instant::now() + Duration::from_secs(CONFIRM_SECS);
        while st.decision.is_none() {
            let left = end.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            st = guard.cv.wait_timeout(st, left).unwrap_or_else(|e| e.into_inner()).0;
        }
        st.pending = false;
        st.decision.unwrap_or(Decision::Revert)
    };
    if decision == Decision::Keep {
        emit(app, "kept", None, format!("IP-Profil „{}“ behalten: {}", prep.profile.name, describe(&prep.to)), true);
        return;
    }
    emit(app, "reverting", None, "Keine Bestätigung – vorherige Konfiguration wird wiederhergestellt …".into(), true);
    let (ok, msg) = revert(app, prep);
    emit(app, "reverted", None, msg, ok);
}

/// Gesicherte Konfiguration wiederherstellen. Der IST-Zustand wird dafür neu
/// gelesen – so stimmt die Rücknahme auch nach einem halb gescheiterten Anwenden.
fn revert(app: &AppHandle, prep: &Prepared) -> (bool, String) {
    let current = crate::adapters::list_adapters()
        .ok()
        .and_then(|list| list.into_iter().find(|a| a.id == prep.adapter.id))
        .and_then(|a| current_config(&a, read_dns_static(&a.id)).ok().map(|(c, _)| c))
        .unwrap_or_else(|| prep.to.clone());
    let steps: Vec<Step> = build_steps(&prep.adapter.name, &current, &prep.from).into_iter().map(Step::always).collect();
    if steps.is_empty() {
        return (true, format!("Vorherige Konfiguration ist aktiv: {}", describe(&prep.from)));
    }
    let plan = Plan {
        title: format!("Vorherige IP-Konfiguration wiederherstellen – Adapter \"{}\"", prep.adapter.name),
        steps,
    };
    let id = RESTORE_ID.fetch_add(1, Ordering::SeqCst);
    match run_plan_blocking(app, id, plan) {
        Ok(r) if r.ok() => (true, format!("Vorherige Konfiguration wiederhergestellt: {}", describe(&prep.from))),
        Ok(_) => (
            false,
            format!(
                "Wiederherstellen teilweise fehlgeschlagen (siehe Konsole). Bitte von Hand prüfen – vorher war: {}",
                describe(&prep.from)
            ),
        ),
        Err(e) => (false, format!("Wiederherstellen nicht möglich: {e}. Vorher war: {}", describe(&prep.from))),
    }
}

/// „Behalten“ – nur während des Countdowns.
#[tauri::command]
pub fn ip_profile_keep(guard: State<'_, IpGuard>) -> Result<(), String> {
    if !guard.lock().pending {
        return Err("Es wartet keine IP-Änderung auf Bestätigung.".into());
    }
    guard.decide(Decision::Keep);
    Ok(())
}

/// „Jetzt zurücksetzen“ – sofort wiederherstellen statt den Countdown abzuwarten.
#[tauri::command]
pub fn ip_profile_revert(guard: State<'_, IpGuard>) -> Result<(), String> {
    if !guard.lock().pending {
        return Err("Es wartet keine IP-Änderung auf Bestätigung.".into());
    }
    guard.decide(Decision::Revert);
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::Ipv4Entry;

    fn ip(s: &str) -> Ipv4Addr {
        s.parse().unwrap()
    }

    fn static_profile(ipv4: &str, subnet: &str, gw: &str) -> IpProfile {
        IpProfile {
            name: "Büro".into(),
            adapter: "Ethernet".into(),
            mac: "aa:bb:cc:01:02:03".into(),
            mode: ProfileMode::Static,
            ipv4: ipv4.into(),
            subnet: subnet.into(),
            gateway: gw.into(),
            dns1: "1.1.1.1".into(),
            dns2: String::new(),
        }
    }

    fn adapter(name: &str, mac: &str) -> AdapterInfo {
        AdapterInfo {
            id: format!("{{{name}}}"),
            name: name.into(),
            description: String::new(),
            connected: true,
            mac: mac.into(),
            ipv4: vec![Ipv4Entry { address: "192.168.1.42".into(), subnet_mask: "255.255.255.0".into() }],
            ipv6: vec![],
            gateways: vec!["192.168.1.1".into()],
            dns_servers: vec!["192.168.1.1".into()],
            dhcp_enabled: true,
            dhcp_server: None,
            lease_obtained: None,
            lease_expires: None,
            dns_suffix: String::new(),
        }
    }

    #[test]
    fn masken() {
        assert_eq!(parse_mask("255.255.255.0").unwrap(), (ip("255.255.255.0"), 24));
        assert_eq!(parse_mask("/24").unwrap().1, 24);
        assert_eq!(parse_mask("8").unwrap(), (ip("255.0.0.0"), 8));
        assert_eq!(parse_mask("/32").unwrap().0, ip("255.255.255.255"));
        assert_eq!(parse_mask("/1").unwrap().0, ip("128.0.0.0"));
        assert_eq!(parse_mask("255.255.255.252").unwrap().1, 30);
        for bad in ["255.0.255.0", "255.255.255.1", "0.0.0.0", "/0", "/33", "33", "abc", "", "255.255.255"] {
            assert!(parse_mask(bad).is_err(), "{bad:?} sollte abgelehnt werden");
        }
        assert_eq!(prefix_to_mask(0), ip("0.0.0.0"));
        assert_eq!(prefix_to_mask(25), ip("255.255.255.128"));
    }

    #[test]
    fn gueltiges_statisches_profil() {
        let p = check_profile(&static_profile("192.168.10.20", "/24", "192.168.10.1")).unwrap();
        assert_eq!(p.subnet, "255.255.255.0", "Maske wird normalisiert");
        assert_eq!(p.mac, "AA-BB-CC-01-02-03");
        let net = to_net_config(&p).unwrap();
        assert_eq!(
            net.addr,
            AddrConfig::Static { ip: ip("192.168.10.20"), mask: ip("255.255.255.0"), gateway: Some(ip("192.168.10.1")) }
        );
        assert_eq!(net.dns, DnsConfig::Static(vec![ip("1.1.1.1")]));
    }

    #[test]
    fn verbotene_adressen() {
        let cases = [
            ("192.168.10.0", "/24", ""),             // Netzadresse
            ("192.168.10.255", "/24", ""),           // Broadcast
            ("224.0.0.5", "/24", ""),                // Multicast
            ("127.0.0.1", "/8", ""),                 // Loopback
            ("0.0.0.0", "/24", ""),                  // unspezifiziert
            ("250.1.1.1", "/24", ""),                // reserviert
            ("192.168.10.20", "/24", "192.168.11.1"), // Gateway ausserhalb
            ("192.168.10.20", "/24", "192.168.10.20"), // Gateway = eigene IP
            ("192.168.10.20", "/24", "192.168.10.255"), // Gateway = Broadcast
            ("192.168.10.20", "255.0.255.0", ""),    // Lücke in der Maske
            ("192.168.010.20", "/24", ""),           // führende Null
            ("192.168.10.20", "/32", "192.168.10.1"), // /32: kein Gateway möglich
        ];
        for (a, m, g) in cases {
            assert!(check_profile(&static_profile(a, m, g)).is_err(), "{a} {m} {g} sollte abgelehnt werden");
        }
    }

    #[test]
    fn sonderfaelle_31_und_32() {
        // /31 (RFC 3021): beide Adressen nutzbar
        assert!(check_profile(&static_profile("10.0.0.0", "/31", "10.0.0.1")).is_ok());
        assert!(check_profile(&static_profile("10.0.0.1", "/31", "")).is_ok());
        assert!(check_profile(&static_profile("10.0.0.5", "/32", "")).is_ok());
    }

    #[test]
    fn dns_regeln() {
        let mut p = static_profile("192.168.10.20", "/24", "");
        p.dns1 = String::new();
        p.dns2 = "8.8.8.8".into();
        assert!(check_profile(&p).is_err(), "DNS 2 ohne DNS 1");
        p.dns1 = "8.8.8.8".into();
        assert!(check_profile(&p).is_err(), "doppelt");
        p.dns2 = "255.255.255.255".into();
        assert!(check_profile(&p).is_err(), "Broadcast als DNS");
        p.dns2 = "127.0.0.1".into();
        assert!(check_profile(&p).is_ok(), "lokaler DNS erlaubt");

        // DHCP ohne DNS → DNS per DHCP; DHCP mit DNS → feste DNS-Server
        let mut d = static_profile("", "", "");
        d.mode = ProfileMode::Dhcp;
        d.dns1 = String::new();
        assert_eq!(to_net_config(&d).unwrap(), NetConfig { addr: AddrConfig::Dhcp, dns: DnsConfig::Dhcp });
        d.dns1 = "9.9.9.9".into();
        assert_eq!(to_net_config(&d).unwrap().dns, DnsConfig::Static(vec![ip("9.9.9.9")]));
        // Bei DHCP werden alte statische Felder beim Speichern geleert
        d.ipv4 = "1.2.3.4".into();
        assert_eq!(check_profile(&d).unwrap().ipv4, "");
    }

    #[test]
    fn name_und_adapter() {
        let mut p = static_profile("192.168.10.20", "/24", "");
        p.adapter = "WLAN & calc".into();
        assert!(check_profile(&p).is_err());
        let mut p = static_profile("192.168.10.20", "/24", "");
        p.name = "  ".into();
        assert!(check_profile(&p).is_err());
        let mut p = static_profile("192.168.10.20", "/24", "");
        p.mac = "zz".into();
        assert!(check_profile(&p).is_err());
    }

    #[test]
    fn adapter_ueber_mac_finden() {
        let list = vec![adapter("WLAN", "AA-BB-CC-01-02-03"), adapter("Ethernet 2", "10-22-33-44-55-66")];
        let mut p = static_profile("192.168.10.20", "/24", "");
        p.mac = "AA-BB-CC-01-02-03".into();
        p.adapter = "Alter Name".into(); // umbenannt → trotzdem gefunden
        assert_eq!(resolve_adapter(&p, &list).unwrap().name, "WLAN");
        p.mac = "AA-AA-AA-AA-AA-AA".into();
        assert!(resolve_adapter(&p, &list).is_err());
        // ohne MAC: exakter Name
        p.mac = String::new();
        p.adapter = "Ethernet 2".into();
        assert_eq!(resolve_adapter(&p, &list).unwrap().name, "Ethernet 2");
        p.adapter = "ethernet 2".into();
        assert!(resolve_adapter(&p, &list).is_err());
        // gleiche MAC zweimal → Name entscheidet
        let list = vec![adapter("Ethernet", "AA-BB-CC-01-02-03"), adapter("vEthernet (Extern)", "AA-BB-CC-01-02-03")];
        p.mac = "AA-BB-CC-01-02-03".into();
        p.adapter = "vEthernet (Extern)".into();
        assert_eq!(resolve_adapter(&p, &list).unwrap().name, "vEthernet (Extern)");
        p.adapter = "Weg".into();
        assert!(resolve_adapter(&p, &list).is_err());
    }

    #[test]
    fn sicherung_der_aktuellen_konfiguration() {
        let a = adapter("WLAN", "AA-BB-CC-01-02-03");
        let (c, notes) = current_config(&a, Some(false)).unwrap();
        assert_eq!(c, NetConfig { addr: AddrConfig::Dhcp, dns: DnsConfig::Dhcp });
        assert!(notes.is_empty());
        // DHCP mit fest eingetragenem DNS
        let (c, _) = current_config(&a, Some(true)).unwrap();
        assert_eq!(c.dns, DnsConfig::Static(vec![ip("192.168.1.1")]));

        let mut s = a.clone();
        s.dhcp_enabled = false;
        s.ipv4.push(Ipv4Entry { address: "192.168.1.43".into(), subnet_mask: "255.255.255.0".into() });
        s.dns_servers = vec!["1.1.1.1".into(), "8.8.8.8".into(), "9.9.9.9".into(), "fe80::1".into()];
        let (c, notes) = current_config(&s, None).unwrap();
        assert_eq!(
            c.addr,
            AddrConfig::Static { ip: ip("192.168.1.42"), mask: ip("255.255.255.0"), gateway: Some(ip("192.168.1.1")) }
        );
        assert_eq!(c.dns, DnsConfig::Static(vec![ip("1.1.1.1"), ip("8.8.8.8")]));
        assert_eq!(notes.len(), 2, "Hinweise: 2 IPs, 3 DNS-Server");

        s.ipv4.clear();
        assert!(current_config(&s, None).is_err(), "statisch ohne IP kann nicht gesichert werden");
    }

    fn labels(steps: &[Step]) -> Vec<String> {
        steps.iter().map(Step::label).collect()
    }

    #[test]
    fn netsh_schritte() {
        let dhcp = NetConfig { addr: AddrConfig::Dhcp, dns: DnsConfig::Dhcp };
        let fixed = NetConfig {
            addr: AddrConfig::Static { ip: ip("192.168.10.20"), mask: ip("255.255.255.0"), gateway: Some(ip("192.168.10.1")) },
            dns: DnsConfig::Static(vec![ip("1.1.1.1"), ip("8.8.8.8")]),
        };
        assert_eq!(
            labels(&build_steps("Ethernet 2", &dhcp, &fixed)),
            [
                "netsh interface ipv4 set address \"Ethernet 2\" static 192.168.10.20 255.255.255.0 192.168.10.1",
                "netsh interface ipv4 set dnsservers \"Ethernet 2\" static 1.1.1.1 primary validate=no",
                "netsh interface ipv4 add dnsservers \"Ethernet 2\" 8.8.8.8 index=2 validate=no",
            ]
        );
        assert_eq!(
            labels(&build_steps("WLAN", &fixed, &dhcp)),
            ["netsh interface ipv4 set address WLAN dhcp", "netsh interface ipv4 set dnsservers WLAN dhcp"]
        );
        // Name ist ein eigenes Argument (nicht in einen String eingebaut)
        let steps = build_steps("vEthernet (WSL)", &dhcp, &fixed);
        let crate::runner::StepKind::Run { program, args } = &steps[0].kind else { panic!("Run erwartet") };
        assert_eq!(*program, "netsh");
        assert_eq!(args[4], "vEthernet (WSL)");

        // Unverändertes wird übersprungen (DHCP→DHCP würde netsh mit Fehler beenden)
        let dhcp_dns = NetConfig { addr: AddrConfig::Dhcp, dns: DnsConfig::Static(vec![ip("9.9.9.9")]) };
        assert_eq!(
            labels(&build_steps("WLAN", &dhcp, &dhcp_dns)),
            ["netsh interface ipv4 set dnsservers WLAN static 9.9.9.9 primary validate=no"]
        );
        assert!(build_steps("WLAN", &dhcp, &dhcp).is_empty());

        // Ohne Gateway und ohne DNS
        let bare = NetConfig {
            addr: AddrConfig::Static { ip: ip("10.0.0.5"), mask: ip("255.0.0.0"), gateway: None },
            dns: DnsConfig::Static(vec![]),
        };
        assert_eq!(
            labels(&build_steps("LAN", &dhcp, &bare)),
            [
                "netsh interface ipv4 set address LAN static 10.0.0.5 255.0.0.0 gateway=none",
                "netsh interface ipv4 set dnsservers LAN static none",
            ]
        );
    }

    #[test]
    fn beschreibung() {
        let c = NetConfig {
            addr: AddrConfig::Static { ip: ip("192.168.10.20"), mask: ip("255.255.255.0"), gateway: None },
            dns: DnsConfig::Static(vec![ip("1.1.1.1")]),
        };
        assert_eq!(describe(&c), "statisch 192.168.10.20/24, kein Gateway, DNS 1.1.1.1");
        assert_eq!(describe(&NetConfig { addr: AddrConfig::Dhcp, dns: DnsConfig::Dhcp }), "DHCP, DNS automatisch");
    }

    #[test]
    fn json_format() {
        let json = r#"{"name":"Labor","adapter":"Ethernet","mac":"AA-BB-CC-01-02-03","mode":"static",
                       "ipv4":"10.1.2.3","subnet":"/16","gateway":"","dns1":"","dns2":""}"#;
        let p: IpProfile = serde_json::from_str(json).unwrap();
        assert_eq!(p.mode, ProfileMode::Static);
        assert_eq!(check_profile(&p).unwrap().subnet, "255.255.0.0");
        assert!(serde_json::from_str::<IpProfile>(r#"{"name":"x","adapter":"y","mode":"bridge"}"#).is_err());
    }
}
