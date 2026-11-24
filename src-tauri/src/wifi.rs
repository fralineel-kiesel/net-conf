//! WLAN-Infos (SSID, Signal, Kanal, Band …) über die Windows-WLAN-API (wlanapi.dll).
//!
//! Ablauf: WlanOpenHandle → WlanEnumInterfaces → pro Interface
//! WlanQueryInterface (aktuelle Verbindung, Kanal) → WlanGetNetworkBssList
//! (für Frequenz und Signalstärke in dBm) → alles mit WlanFreeMemory freigeben.
//!
//! Wichtig ab Windows 11 24H2: Für SSID/BSSID verlangt Windows, dass Desktop-Apps
//! Standortzugriff haben (Einstellungen → Datenschutz → Standort). Sonst kommt
//! "Zugriff verweigert" – wir zeigen dann eine verständliche Meldung.
//!
//! Seite "WLAN" (F7, Phase 4b) zusätzlich:
//! * `scan` (WlanScan) und `networks` (WlanGetAvailableNetworkList + WlanGetNetworkBssList)
//! * `profiles` (WlanGetProfileList), `forget` (WlanDeleteProfile)
//! * `connect_profile` / `connect_new` (WlanSetProfile + WlanConnect, Ergebnis per
//!   Benachrichtigung von Windows), `disconnect` (WlanDisconnect)
//!
//! Das Frontend schickt nur die Interface-GUID (wird mit der echten Liste
//! verglichen, nie selbst geparst), Profilnamen (müssen exakt existieren) und
//! für neue Netze SSID + Passwort (Prüfung und XML: `wifiprofile.rs`).

// Die reine Logik hier nutzt nur der Windows-Teil – unter Linux (cargo test)
// wäre sie sonst "unbenutzt". Massgeblich ist clippy für das Windows-Target.
#![cfg_attr(not(windows), allow(dead_code))]

use crate::wifiprofile::Security;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WifiInfo {
    /// Interface-GUID im Format "{XXXXXXXX-…}" – passt zu AdapterInfo.id
    pub interface_id: String,
    pub description: String,
    pub connected: bool,
    /// Zustand auf Deutsch, z. B. "verbunden", "getrennt"
    pub state: String,
    pub ssid: String,
    pub bssid: String,
    pub profile: String,
    /// Signalqualität 0–100 %
    pub signal_quality: Option<u32>,
    /// Signalstärke in dBm (z. B. -55), aus der BSS-Liste
    pub rssi_dbm: Option<i32>,
    pub channel: Option<u32>,
    pub frequency_mhz: Option<u32>,
    /// "2,4 GHz", "5 GHz" oder "6 GHz"
    pub band: Option<String>,
    /// z. B. "802.11ax (Wi-Fi 6)"
    pub phy: String,
    pub rx_mbps: Option<f64>,
    pub tx_mbps: Option<f64>,
    pub auth: String,
    pub cipher: String,
    /// Fehlermeldung für dieses Interface (z. B. fehlender Standortzugriff)
    pub error: Option<String>,
}

pub fn wifi_interfaces() -> Result<Vec<WifiInfo>, String> {
    imp::wifi_interfaces()
}

/// Netze in der Umgebung (letzter Scan von Windows) + einzelne Access Points.
pub fn networks(interface_id: &str) -> Result<WifiScanResult, String> {
    imp::networks(interface_id)
}

/// Neuen Scan anstossen. Windows braucht danach 2–4 s, bis die Liste aktuell ist.
pub fn scan(interface_id: &str) -> Result<(), String> {
    imp::scan(interface_id)
}

pub fn profiles(interface_id: &str) -> Result<Vec<WifiProfile>, String> {
    imp::profiles(interface_id)
}

/// Mit einem gespeicherten Profil verbinden (wartet auf das Ergebnis, max. 30 s).
pub fn connect_profile(interface_id: &str, profile: &str) -> Result<String, String> {
    validate_profile_name(profile)?;
    let _busy = ConnectGuard::acquire()?;
    imp::connect_profile(interface_id, profile)
}

/// Neues Profil anlegen und verbinden. Das Passwort wird danach überschrieben.
pub fn connect_new(req: WifiConnectRequest) -> Result<String, String> {
    let _busy = match ConnectGuard::acquire() {
        Ok(g) => g,
        Err(e) => {
            crate::wifiprofile::wipe_string(req.password);
            return Err(e);
        }
    };
    imp::connect_new(req)
}

pub fn disconnect(interface_id: &str) -> Result<(), String> {
    imp::disconnect(interface_id)
}

/// Gespeichertes Profil löschen ("Vergessen").
pub fn forget(interface_id: &str, profile: &str) -> Result<(), String> {
    validate_profile_name(profile)?;
    imp::forget(interface_id, profile)
}

/// Profilname grob prüfen – verbindlich ist der exakte Abgleich mit der Profilliste.
fn validate_profile_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.chars().count() > 255 || name.chars().any(char::is_control) {
        return Err("Ungültiger Profilname.".into());
    }
    Ok(())
}

/// Es läuft immer nur ein Verbindungsversuch gleichzeitig.
static CONNECTING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

struct ConnectGuard;
impl ConnectGuard {
    fn acquire() -> Result<ConnectGuard, String> {
        use std::sync::atomic::Ordering;
        if CONNECTING.swap(true, Ordering::SeqCst) {
            return Err("Es läuft schon ein Verbindungsversuch – bitte warten.".into());
        }
        Ok(ConnectGuard)
    }
}
impl Drop for ConnectGuard {
    fn drop(&mut self) {
        CONNECTING.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Band aus der Mittenfrequenz (MHz).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn band_from_mhz(mhz: u32) -> Option<String> {
    match mhz {
        2400..=2500 => Some("2,4 GHz".into()),
        4900..=5899 => Some("5 GHz".into()),
        5925..=7125 => Some("6 GHz".into()),
        _ => None,
    }
}

/// Band nur aus dem Kanal (Notlösung, wenn die Frequenz fehlt).
/// 6-GHz-Kanäle überschneiden sich mit den Nummern – daher nur 2,4/5 GHz.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn band_from_channel(ch: u32) -> Option<String> {
    match ch {
        1..=14 => Some("2,4 GHz".into()),
        32..=177 => Some("5 GHz".into()),
        _ => None,
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
pub const LOCATION_HINT: &str = "Windows gibt die WLAN-Details nur mit Standortzugriff frei: \
Einstellungen → Datenschutz und Sicherheit → Standort → „Desktop-Apps den Zugriff auf Ihren Standort erlauben“ einschalten.";

/// Hinweis, wenn die Netzliste leer ist oder Namen fehlen (Standortdienste).
pub const NAMES_HIDDEN_HINT: &str = "Windows blendet WLAN-Namen aus, wenn die Standortdienste aus sind: \
Einstellungen > Datenschutz & Sicherheit > Standort.";

// ---------------------------------------------------------------------------
// Phase 4b: Netze in der Umgebung, Profile, Verbinden
// ---------------------------------------------------------------------------

/// Ein Netz (SSID) in der Umgebung – mehrere Access Points mit gleicher SSID
/// sind zu einer Zeile zusammengefasst.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WifiNetwork {
    /// leer bei versteckten Netzen
    pub ssid: String,
    pub hidden: bool,
    /// Signalqualität 0–100 % des stärksten Access Points
    pub signal: u32,
    pub rssi_dbm: Option<i32>,
    /// Kanal/Band des stärksten Access Points
    pub channel: Option<u32>,
    pub band: Option<String>,
    pub ap_count: u32,
    /// Anzeige: "OFFEN", "WPA2", "WPA3", "WEP", "WPA", "OWE", "802.1X", "?"
    pub security: String,
    /// So kann Net-Conf verbinden; None = nicht unterstützt (z. B. 802.1X)
    pub connect_as: Option<Security>,
    pub connected: bool,
    /// Es gibt ein gespeichertes Windows-Profil
    pub saved: bool,
    pub profile: String,
}

/// Ein einzelner Access Point (für die Kanal-Belegung).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WifiBss {
    pub ssid: String,
    pub bssid: String,
    pub signal: u32,
    pub rssi_dbm: i32,
    pub frequency_mhz: u32,
    pub channel: Option<u32>,
    pub band: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WifiScanResult {
    pub networks: Vec<WifiNetwork>,
    pub bss: Vec<WifiBss>,
    /// z. B. Hinweis auf fehlenden Standortzugriff
    pub hint: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WifiProfile {
    pub name: String,
    /// Profil aus einer Gruppenrichtlinie (Firma) – kann nicht gelöscht werden
    pub group_policy: bool,
    /// Profil nur für den aktuellen Benutzer
    pub per_user: bool,
}

/// Anfrage "mit neuem Netz verbinden". KEIN Debug-derive (Passwort!).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WifiConnectRequest {
    pub interface_id: String,
    pub ssid: String,
    /// leer bei offenen Netzen
    pub password: String,
    /// Wahl im Frontend – gilt nur, wenn das Netz nicht sichtbar ist (verstecktes Netz)
    pub security: Security,
    pub hidden: bool,
}

/// Kanal aus der Mittenfrequenz (MHz).
pub fn channel_from_mhz(mhz: u32) -> Option<u32> {
    match mhz {
        2484 => Some(14),
        2412..=2472 => Some((mhz - 2407) / 5),
        5150..=5895 => Some((mhz - 5000) / 5),
        5935 => Some(2),
        5955..=7115 => Some((mhz - 5950) / 5),
        _ => None,
    }
}

// Werte von DOT11_AUTH_ALGORITHM / DOT11_CIPHER_ALGORITHM (stabile Windows-ABI).
// Hier als eigene Konstanten, damit die Logik auch unter Linux testbar ist.
const AUTH_OPEN: i32 = 1;
const AUTH_SHARED_KEY: i32 = 2;
const AUTH_WPA: i32 = 3;
const AUTH_WPA_PSK: i32 = 4;
const AUTH_RSNA: i32 = 6;
const AUTH_RSNA_PSK: i32 = 7;
const AUTH_WPA3_ENT_192: i32 = 8;
const AUTH_WPA3_SAE: i32 = 9;
const AUTH_OWE: i32 = 10;
const AUTH_WPA3_ENT: i32 = 11;
const CIPHER_NONE: i32 = 0;

/// Sicherheit eines Netzes als Text + ob Net-Conf damit verbinden kann.
pub fn classify_security(auth: i32, cipher: i32) -> (&'static str, Option<Security>) {
    match auth {
        AUTH_OPEN if cipher == CIPHER_NONE => ("OFFEN", Some(Security::Open)),
        AUTH_OPEN | AUTH_SHARED_KEY => ("WEP", None),
        AUTH_WPA_PSK => ("WPA", None),
        AUTH_RSNA_PSK => ("WPA2", Some(Security::Wpa2)),
        AUTH_WPA3_SAE => ("WPA3", Some(Security::Wpa3)),
        AUTH_OWE => ("OWE", None),
        AUTH_WPA | AUTH_RSNA | AUTH_WPA3_ENT | AUTH_WPA3_ENT_192 => ("802.1X", None),
        _ => ("?", None),
    }
}

/// Hinweis auf die Standortdienste, wenn die Liste leer ist oder ALLE Namen fehlen.
pub fn names_hint(networks: &[WifiNetwork]) -> Option<String> {
    (networks.is_empty() || networks.iter().all(|n| n.hidden)).then(|| NAMES_HIDDEN_HINT.to_string())
}

/// Meldung, wenn Net-Conf mit dieser Sicherheit nicht verbinden kann.
pub fn unsupported_text(security: &str) -> String {
    match security {
        "802.1X" => "[802.1X] nicht unterstützt, bitte über Windows verbinden.".into(),
        "WEP" | "WPA" => format!("{security} ist veraltet und unsicher – Net-Conf verbindet damit nicht. Bitte über Windows verbinden."),
        "OWE" => "OWE (Enhanced Open) wird nicht unterstützt, bitte über Windows verbinden.".into(),
        _ => "Diese Sicherheitsart wird nicht unterstützt, bitte über Windows verbinden.".into(),
    }
}

/// Eintrag aus WlanGetAvailableNetworkList (vereinfacht, ohne Windows-Typen).
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, Clone)]
pub struct RawNetwork {
    pub ssid: String,
    pub signal: u32,
    pub auth: i32,
    pub cipher: i32,
    pub connected: bool,
    pub has_profile: bool,
    pub profile: String,
    pub bss_count: u32,
}

/// Netze und Access Points zu einer Liste zusammenfassen.
///
/// Windows liefert ein Netz mit gespeichertem Profil oft doppelt (einmal mit,
/// einmal ohne Profilname) – darum wird nach SSID gruppiert (versteckte Netze:
/// alle zusammen). Kanal/Band/dBm stammen vom stärksten Access Point.
pub fn merge_networks(raw: &[RawNetwork], bss: &[WifiBss]) -> Vec<WifiNetwork> {
    let mut out: Vec<WifiNetwork> = Vec::new();
    for r in raw {
        let (sec, connect_as) = classify_security(r.auth, r.cipher);
        if let Some(n) = out.iter_mut().find(|n| n.ssid == r.ssid) {
            n.connected |= r.connected;
            n.saved |= r.has_profile;
            if n.profile.is_empty() && !r.profile.is_empty() {
                n.profile = r.profile.clone();
            }
            n.signal = n.signal.max(r.signal.min(100));
            n.ap_count = n.ap_count.max(r.bss_count);
            continue;
        }
        out.push(WifiNetwork {
            ssid: r.ssid.clone(),
            hidden: r.ssid.is_empty(),
            signal: r.signal.min(100),
            rssi_dbm: None,
            channel: None,
            band: None,
            ap_count: r.bss_count,
            security: sec.into(),
            connect_as,
            connected: r.connected,
            saved: r.has_profile,
            profile: r.profile.clone(),
        });
    }
    // Access Points ohne Eintrag in der Netzliste trotzdem zeigen (Sicherheit unbekannt)
    for b in bss {
        if !out.iter().any(|n| n.ssid == b.ssid) {
            out.push(WifiNetwork {
                ssid: b.ssid.clone(),
                hidden: b.ssid.is_empty(),
                signal: 0,
                rssi_dbm: None,
                channel: None,
                band: None,
                ap_count: 0,
                security: "?".into(),
                connect_as: None,
                connected: false,
                saved: false,
                profile: String::new(),
            });
        }
    }
    for n in &mut out {
        let aps: Vec<&WifiBss> = bss.iter().filter(|b| b.ssid == n.ssid).collect();
        if let Some(best) = aps.iter().max_by_key(|b| (b.signal, b.rssi_dbm)) {
            n.channel = best.channel;
            n.band = best.band.clone();
            n.rssi_dbm = Some(best.rssi_dbm);
            n.signal = n.signal.max(best.signal.min(100));
        }
        if !aps.is_empty() {
            n.ap_count = aps.len() as u32;
        }
        n.ap_count = n.ap_count.max(1);
    }
    out.sort_by(|a, b| {
        b.connected
            .cmp(&a.connected)
            .then(b.signal.cmp(&a.signal))
            .then_with(|| a.ssid.to_lowercase().cmp(&b.ssid.to_lowercase()))
    });
    out
}

/// Grund eines gescheiterten Verbindungsversuchs (WLAN_REASON_CODE) → deutsche Meldung.
/// `None` = unbekannter Grund (dann zeigt der Aufrufer den Windows-Text).
pub fn explain_reason(code: u32) -> Option<&'static str> {
    // Werte aus wlanapi.h (stabil)
    const NETWORK_NOT_AVAILABLE: u32 = 163_851;
    const ASSOCIATION_FAILURE: u32 = 229_378;
    const ASSOCIATION_TIMEOUT: u32 = 229_379;
    const MSMSEC_AUTH_START_TIMEOUT: u32 = 294_914;
    const MSMSEC_AUTH_SUCCESS_TIMEOUT: u32 = 294_915;
    const MSMSEC_KEY_START_TIMEOUT: u32 = 294_916;
    const MSMSEC_KEY_SUCCESS_TIMEOUT: u32 = 294_917;
    const MSMSEC_PSK_MISMATCH_SUSPECTED: u32 = 294_932;
    match code {
        // Beim 4-Wege-Handshake bleibt der Router stumm, wenn das Passwort nicht passt
        MSMSEC_PSK_MISMATCH_SUSPECTED | MSMSEC_KEY_START_TIMEOUT | MSMSEC_KEY_SUCCESS_TIMEOUT => {
            Some("Das Passwort ist vermutlich falsch. Bitte prüfen (Gross-/Kleinschreibung!) und erneut versuchen.")
        }
        MSMSEC_AUTH_START_TIMEOUT | MSMSEC_AUTH_SUCCESS_TIMEOUT | ASSOCIATION_TIMEOUT => {
            Some("Zeitüberschreitung: Der Access Point hat nicht rechtzeitig geantwortet. Näher an den Router gehen und erneut versuchen.")
        }
        NETWORK_NOT_AVAILABLE | ASSOCIATION_FAILURE => {
            Some("Das Netz ist nicht erreichbar (ausser Reichweite oder ausgeschaltet). Bitte neu scannen.")
        }
        _ => None,
    }
}

#[cfg(windows)]
mod imp {
    use super::{band_from_channel, band_from_mhz, WifiInfo, LOCATION_HINT};
    use windows_sys::core::GUID;
    use windows_sys::Win32::Foundation::{ERROR_ACCESS_DENIED, ERROR_SUCCESS, HANDLE};
    use windows_sys::Win32::NetworkManagement::WiFi::*;

    /// Gibt WLAN-Speicher beim Verlassen des Blocks automatisch frei ("Drop-Guard").
    struct WlanMem(*mut core::ffi::c_void);
    impl Drop for WlanMem {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: Zeiger stammt von einer Wlan*-Funktion.
                unsafe { WlanFreeMemory(self.0) };
            }
        }
    }

    /// Schliesst das WLAN-Handle automatisch.
    struct WlanHandle(HANDLE);
    impl Drop for WlanHandle {
        fn drop(&mut self) {
            // SAFETY: Handle stammt von WlanOpenHandle.
            unsafe { WlanCloseHandle(self.0, std::ptr::null()) };
        }
    }

    fn guid_string(g: &GUID) -> String {
        format!(
            "{{{:08X}-{:04X}-{:04X}-{:02X}{:02X}-{:02X}{:02X}{:02X}{:02X}{:02X}{:02X}}}",
            g.data1, g.data2, g.data3, g.data4[0], g.data4[1], g.data4[2], g.data4[3], g.data4[4],
            g.data4[5], g.data4[6], g.data4[7]
        )
    }

    fn utf16_fixed(buf: &[u16]) -> String {
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..len])
    }

    fn ssid_string(ssid: &DOT11_SSID) -> String {
        let len = (ssid.uSSIDLength as usize).min(ssid.ucSSID.len());
        String::from_utf8_lossy(&ssid.ucSSID[..len]).into_owned()
    }

    fn mac_string(b: &[u8; 6]) -> String {
        b.iter().map(|x| format!("{x:02X}")).collect::<Vec<_>>().join("-")
    }

    fn state_text(s: i32) -> &'static str {
        match s {
            0 => "nicht bereit",
            1 => "verbunden",
            2 => "Ad-hoc-Netz",
            3 => "trennt …",
            4 => "getrennt",
            5 => "verbindet …",
            6 => "sucht Netze …",
            7 => "authentifiziert …",
            _ => "unbekannt",
        }
    }

    fn phy_text(p: i32) -> String {
        match p {
            4 => "802.11a",
            5 => "802.11b",
            6 => "802.11g",
            7 => "802.11n (Wi-Fi 4)",
            8 => "802.11ac (Wi-Fi 5)",
            9 => "802.11ad",
            10 => "802.11ax (Wi-Fi 6/6E)",
            11 => "802.11be (Wi-Fi 7)",
            _ => "unbekannt",
        }
        .to_string()
    }

    fn auth_text(a: i32) -> String {
        match a {
            DOT11_AUTH_ALGO_80211_OPEN => "Offen",
            DOT11_AUTH_ALGO_80211_SHARED_KEY => "WEP (Shared Key)",
            DOT11_AUTH_ALGO_WPA => "WPA-Enterprise",
            DOT11_AUTH_ALGO_WPA_PSK => "WPA-Personal",
            DOT11_AUTH_ALGO_RSNA => "WPA2-Enterprise",
            DOT11_AUTH_ALGO_RSNA_PSK => "WPA2-Personal",
            DOT11_AUTH_ALGO_WPA3_ENT_192 => "WPA3-Enterprise 192",
            DOT11_AUTH_ALGO_WPA3_SAE => "WPA3-Personal",
            DOT11_AUTH_ALGO_OWE => "OWE (Enhanced Open)",
            DOT11_AUTH_ALGO_WPA3_ENT => "WPA3-Enterprise",
            _ => "unbekannt",
        }
        .to_string()
    }

    fn cipher_text(c: i32) -> String {
        match c {
            DOT11_CIPHER_ALGO_NONE => "keine",
            DOT11_CIPHER_ALGO_WEP40 | DOT11_CIPHER_ALGO_WEP104 | DOT11_CIPHER_ALGO_WEP => "WEP",
            DOT11_CIPHER_ALGO_TKIP => "TKIP",
            DOT11_CIPHER_ALGO_CCMP => "AES (CCMP)",
            DOT11_CIPHER_ALGO_CCMP_256 => "AES-256 (CCMP)",
            DOT11_CIPHER_ALGO_GCMP => "AES (GCMP)",
            DOT11_CIPHER_ALGO_GCMP_256 => "AES-256 (GCMP)",
            _ => "unbekannt",
        }
        .to_string()
    }

    pub fn wifi_interfaces() -> Result<Vec<WifiInfo>, String> {
        let mut negotiated = 0u32;
        let mut raw: HANDLE = std::ptr::null_mut();
        // SAFETY: Ausgabeparameter zeigen auf lokale Variablen.
        let rc = unsafe { WlanOpenHandle(2, std::ptr::null(), &mut negotiated, &mut raw) };
        if rc != ERROR_SUCCESS {
            // z. B. Dienst "WLAN AutoConfig" läuft nicht → PC ohne WLAN. Kein Fehler.
            return Ok(Vec::new());
        }
        let handle = WlanHandle(raw);

        let mut list_ptr: *mut WLAN_INTERFACE_INFO_LIST = std::ptr::null_mut();
        // SAFETY: Windows legt die Liste an, WlanMem gibt sie frei.
        let rc = unsafe { WlanEnumInterfaces(handle.0, std::ptr::null(), &mut list_ptr) };
        if rc != ERROR_SUCCESS || list_ptr.is_null() {
            return Ok(Vec::new());
        }
        let _list_guard = WlanMem(list_ptr as *mut _);

        let mut out = Vec::new();
        // SAFETY: dwNumberOfItems Einträge liegen direkt hintereinander (C-Array
        // mit variabler Länge). Zeiger vom Rohzeiger ableiten, nicht von einer Referenz.
        unsafe {
            let count = (*list_ptr).dwNumberOfItems as usize;
            let items_ptr = std::ptr::addr_of!((*list_ptr).InterfaceInfo) as *const WLAN_INTERFACE_INFO;
            for item in std::slice::from_raw_parts(items_ptr, count) {
                out.push(query_interface(handle.0, item));
            }
        }
        Ok(out)
    }

    /// Details zu einem WLAN-Interface.
    ///
    /// SAFETY: `handle` muss gültig sein, `item` aus WlanEnumInterfaces stammen.
    unsafe fn query_interface(handle: HANDLE, item: &WLAN_INTERFACE_INFO) -> WifiInfo {
        let mut info = WifiInfo {
            interface_id: guid_string(&item.InterfaceGuid),
            description: utf16_fixed(&item.strInterfaceDescription),
            connected: item.isState == wlan_interface_state_connected,
            state: state_text(item.isState).to_string(),
            ..Default::default()
        };
        if !info.connected {
            return info;
        }

        // 1) Aktuelle Verbindung
        let mut size = 0u32;
        let mut data: *mut core::ffi::c_void = std::ptr::null_mut();
        let rc = WlanQueryInterface(
            handle,
            &item.InterfaceGuid,
            wlan_intf_opcode_current_connection,
            std::ptr::null(),
            &mut size,
            &mut data,
            std::ptr::null_mut(),
        );
        if rc == ERROR_ACCESS_DENIED {
            info.error = Some(LOCATION_HINT.into());
            return info;
        }
        if rc != ERROR_SUCCESS || data.is_null() {
            info.error = Some(format!("WLAN-Verbindung konnte nicht gelesen werden (Code {rc})."));
            return info;
        }
        let _conn_guard = WlanMem(data);
        let conn = &*(data as *const WLAN_CONNECTION_ATTRIBUTES);
        let assoc = &conn.wlanAssociationAttributes;
        info.profile = utf16_fixed(&conn.strProfileName);
        info.ssid = ssid_string(&assoc.dot11Ssid);
        info.bssid = mac_string(&assoc.dot11Bssid);
        info.signal_quality = Some(assoc.wlanSignalQuality.min(100));
        info.phy = phy_text(assoc.dot11PhyType);
        // Raten kommen in kbit/s
        info.rx_mbps = Some(assoc.ulRxRate as f64 / 1000.0);
        info.tx_mbps = Some(assoc.ulTxRate as f64 / 1000.0);
        info.auth = auth_text(conn.wlanSecurityAttributes.dot11AuthAlgorithm);
        info.cipher = cipher_text(conn.wlanSecurityAttributes.dot11CipherAlgorithm);
        if info.ssid.is_empty() && info.bssid == "00-00-00-00-00-00" {
            // Manche Windows-Versionen liefern ohne Standortzugriff leere Werte statt Fehler.
            info.error = Some(LOCATION_HINT.into());
        }

        // 2) Kanal
        let mut size = 0u32;
        let mut ch_data: *mut core::ffi::c_void = std::ptr::null_mut();
        let rc = WlanQueryInterface(
            handle,
            &item.InterfaceGuid,
            wlan_intf_opcode_channel_number,
            std::ptr::null(),
            &mut size,
            &mut ch_data,
            std::ptr::null_mut(),
        );
        if rc == ERROR_SUCCESS && !ch_data.is_null() {
            let _ch_guard = WlanMem(ch_data);
            if size as usize >= std::mem::size_of::<u32>() {
                info.channel = Some(*(ch_data as *const u32));
            }
        }

        // 3) Frequenz + dBm aus der BSS-Liste (passender Access Point = gleiche BSSID)
        let mut bss_ptr: *mut WLAN_BSS_LIST = std::ptr::null_mut();
        let rc = WlanGetNetworkBssList(
            handle,
            &item.InterfaceGuid,
            &assoc.dot11Ssid,
            assoc.dot11BssType,
            conn.wlanSecurityAttributes.bSecurityEnabled,
            std::ptr::null(),
            &mut bss_ptr,
        );
        if rc == ERROR_SUCCESS && !bss_ptr.is_null() {
            let _bss_guard = WlanMem(bss_ptr as *mut _);
            let count = (*bss_ptr).dwNumberOfItems as usize;
            let entries_ptr = std::ptr::addr_of!((*bss_ptr).wlanBssEntries) as *const WLAN_BSS_ENTRY;
            for e in std::slice::from_raw_parts(entries_ptr, count) {
                if e.dot11Bssid == assoc.dot11Bssid {
                    info.rssi_dbm = Some(e.lRssi);
                    let mhz = e.ulChCenterFrequency / 1000; // kHz → MHz
                    if mhz > 0 {
                        info.frequency_mhz = Some(mhz);
                    }
                    break;
                }
            }
        }

        info.band = info
            .frequency_mhz
            .and_then(band_from_mhz)
            .or_else(|| info.channel.and_then(band_from_channel));
        info
    }

    // =======================================================================
    // Phase 4b: Netze, Scan, Profile, Verbinden, Trennen
    // =======================================================================

    use super::{
        channel_from_mhz, explain_reason, merge_networks, unsupported_text, classify_security, RawNetwork,
        names_hint, WifiBss, WifiConnectRequest, WifiProfile, WifiScanResult, NAMES_HIDDEN_HINT,
    };
    use crate::wifiprofile::{self, Security};
    use std::ptr::{addr_of, null, null_mut};
    use std::sync::{mpsc, Mutex};
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::ERROR_BUSY;

    const NO_WLAN: &str =
        "Kein WLAN verfügbar: Es gibt keinen WLAN-Adapter oder der Dienst „WLAN-AutoKonfiguration“ läuft nicht.";
    const RADIO_OFF: &str = "WLAN ist ausgeschaltet (Flugmodus oder WLAN-Schalter). Bitte in Windows einschalten.";
    /// "Funk aus" (ERROR_NDIS_DOT11_POWER_STATE_INVALID)
    const POWER_STATE_INVALID: u32 = 0x8034_2002;
    /// So lange warten wir auf das Ergebnis von WlanConnect.
    const CONNECT_TIMEOUT_SECS: u64 = 30;

    fn open_handle() -> Result<WlanHandle, String> {
        let mut negotiated = 0u32;
        let mut raw: HANDLE = null_mut();
        // SAFETY: Ausgabeparameter zeigen auf lokale Variablen.
        let rc = unsafe { WlanOpenHandle(2, null(), &mut negotiated, &mut raw) };
        if rc != ERROR_SUCCESS {
            return Err(NO_WLAN.into());
        }
        Ok(WlanHandle(raw))
    }

    /// Interface mit dieser GUID suchen. Die GUID vom Frontend wird nur mit der
    /// echten Liste von Windows VERGLICHEN, nie selbst in eine GUID umgewandelt.
    fn open_interface(interface_id: &str) -> Result<(WlanHandle, GUID), String> {
        let handle = open_handle()?;
        let mut list_ptr: *mut WLAN_INTERFACE_INFO_LIST = null_mut();
        // SAFETY: Windows legt die Liste an, WlanMem gibt sie frei.
        let rc = unsafe { WlanEnumInterfaces(handle.0, null(), &mut list_ptr) };
        if rc != ERROR_SUCCESS || list_ptr.is_null() {
            return Err(NO_WLAN.into());
        }
        let _guard = WlanMem(list_ptr as *mut _);
        // SAFETY: C-Array mit dwNumberOfItems Einträgen, Zeiger vom Rohzeiger abgeleitet.
        let found = unsafe {
            let count = (*list_ptr).dwNumberOfItems as usize;
            let items_ptr = addr_of!((*list_ptr).InterfaceInfo) as *const WLAN_INTERFACE_INFO;
            std::slice::from_raw_parts(items_ptr, count)
                .iter()
                .find(|i| guid_string(&i.InterfaceGuid).eq_ignore_ascii_case(interface_id.trim()))
                .map(|i| i.InterfaceGuid)
        };
        match found {
            Some(guid) => Ok((handle, guid)),
            None => Err("Der WLAN-Adapter wurde nicht gefunden (entfernt oder deaktiviert?). Bitte neu laden.".into()),
        }
    }

    /// Nullterminierter UTF-16-String für Windows.
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Versteckte Netze melden eine leere SSID oder lauter Null-Bytes → "".
    fn ssid_or_hidden(ssid: &DOT11_SSID) -> String {
        let len = (ssid.uSSIDLength as usize).min(ssid.ucSSID.len());
        if ssid.ucSSID[..len].iter().all(|&b| b == 0) {
            return String::new();
        }
        ssid_string(ssid)
    }

    fn make_ssid(ssid: &str) -> DOT11_SSID {
        // SAFETY: DOT11_SSID besteht nur aus Zahlen – alles 0 ist ein gültiger Wert.
        let mut s: DOT11_SSID = unsafe { std::mem::zeroed() };
        let bytes = ssid.as_bytes();
        let n = bytes.len().min(s.ucSSID.len());
        s.ucSSID[..n].copy_from_slice(&bytes[..n]);
        s.uSSIDLength = n as u32;
        s
    }

    /// Text von Windows zu einem Reason-Code (in der Sprache von Windows).
    fn reason_text(code: u32) -> String {
        let mut buf = [0u16; 512];
        // SAFETY: Puffer und Länge passen zusammen.
        let rc = unsafe { WlanReasonCodeToString(code, buf.len() as u32, buf.as_mut_ptr(), null()) };
        if rc == ERROR_SUCCESS {
            utf16_fixed(&buf).trim().to_string()
        } else {
            String::new()
        }
    }

    fn failure_text(reason: u32) -> String {
        if let Some(t) = explain_reason(reason) {
            return t.into();
        }
        let w = reason_text(reason);
        if w.is_empty() {
            format!("Die Verbindung ist fehlgeschlagen (Grund-Code {reason}).")
        } else {
            format!("Die Verbindung ist fehlgeschlagen: {w} (Code {reason})")
        }
    }

    pub fn networks(interface_id: &str) -> Result<WifiScanResult, String> {
        let (handle, guid) = open_interface(interface_id)?;
        let mut list: *mut WLAN_AVAILABLE_NETWORK_LIST = null_mut();
        // SAFETY: Windows legt die Liste an, WlanMem gibt sie frei.
        let rc = unsafe { WlanGetAvailableNetworkList(handle.0, &guid, 0, null(), &mut list) };
        if rc == ERROR_ACCESS_DENIED {
            // Ab Windows 11 24H2 ohne Standortzugriff: Liste bleibt leer → Hinweis
            return Ok(WifiScanResult { hint: Some(NAMES_HIDDEN_HINT.into()), ..Default::default() });
        }
        if rc == POWER_STATE_INVALID {
            return Err(RADIO_OFF.into());
        }
        if rc != ERROR_SUCCESS || list.is_null() {
            return Err(format!("Die WLAN-Netze konnten nicht gelesen werden (Code {rc})."));
        }
        let _guard = WlanMem(list as *mut _);
        let mut raw = Vec::new();
        // SAFETY: C-Array mit dwNumberOfItems Einträgen, Zeiger vom Rohzeiger abgeleitet.
        unsafe {
            let count = (*list).dwNumberOfItems as usize;
            let p = addr_of!((*list).Network) as *const WLAN_AVAILABLE_NETWORK;
            for n in std::slice::from_raw_parts(p, count) {
                raw.push(RawNetwork {
                    ssid: ssid_or_hidden(&n.dot11Ssid),
                    signal: n.wlanSignalQuality,
                    auth: n.dot11DefaultAuthAlgorithm,
                    cipher: n.dot11DefaultCipherAlgorithm,
                    connected: n.dwFlags & WLAN_AVAILABLE_NETWORK_CONNECTED != 0,
                    has_profile: n.dwFlags & WLAN_AVAILABLE_NETWORK_HAS_PROFILE != 0,
                    profile: utf16_fixed(&n.strProfileName),
                    bss_count: n.uNumberOfBssids,
                });
            }
        }
        let bss = bss_list(handle.0, &guid);
        let networks = merge_networks(&raw, &bss);
        Ok(WifiScanResult { hint: names_hint(&networks), networks, bss })
    }

    /// Alle Access Points (für Kanal/Band/dBm). Fehler → leere Liste.
    fn bss_list(handle: HANDLE, guid: &GUID) -> Vec<WifiBss> {
        let mut p: *mut WLAN_BSS_LIST = null_mut();
        // SAFETY: SSID = NULL → alle Netze; Windows legt die Liste an.
        let rc = unsafe { WlanGetNetworkBssList(handle, guid, null(), dot11_BSS_type_any, 0, null(), &mut p) };
        if rc != ERROR_SUCCESS || p.is_null() {
            return Vec::new();
        }
        let _guard = WlanMem(p as *mut _);
        let mut out = Vec::new();
        // SAFETY: C-Array mit dwNumberOfItems Einträgen, Zeiger vom Rohzeiger abgeleitet.
        unsafe {
            let count = (*p).dwNumberOfItems as usize;
            let entries = addr_of!((*p).wlanBssEntries) as *const WLAN_BSS_ENTRY;
            for e in std::slice::from_raw_parts(entries, count) {
                let mhz = e.ulChCenterFrequency / 1000; // kHz → MHz
                out.push(WifiBss {
                    ssid: ssid_or_hidden(&e.dot11Ssid),
                    bssid: mac_string(&e.dot11Bssid),
                    signal: e.uLinkQuality.min(100),
                    rssi_dbm: e.lRssi,
                    frequency_mhz: mhz,
                    channel: channel_from_mhz(mhz),
                    band: band_from_mhz(mhz),
                });
            }
        }
        out
    }

    /// Sicherheit eines sichtbaren Netzes mit dieser SSID (None = nicht sichtbar).
    fn visible_security(handle: HANDLE, guid: &GUID, ssid: &str) -> Option<(&'static str, Option<Security>)> {
        let mut list: *mut WLAN_AVAILABLE_NETWORK_LIST = null_mut();
        // SAFETY: wie in networks()
        let rc = unsafe { WlanGetAvailableNetworkList(handle, guid, 0, null(), &mut list) };
        if rc != ERROR_SUCCESS || list.is_null() {
            return None;
        }
        let _guard = WlanMem(list as *mut _);
        // SAFETY: wie in networks()
        unsafe {
            let count = (*list).dwNumberOfItems as usize;
            let p = addr_of!((*list).Network) as *const WLAN_AVAILABLE_NETWORK;
            std::slice::from_raw_parts(p, count)
                .iter()
                .find(|n| ssid_or_hidden(&n.dot11Ssid) == ssid)
                .map(|n| classify_security(n.dot11DefaultAuthAlgorithm, n.dot11DefaultCipherAlgorithm))
        }
    }

    pub fn scan(interface_id: &str) -> Result<(), String> {
        let (handle, guid) = open_interface(interface_id)?;
        // SAFETY: keine SSID/IE-Daten → normaler Scan aller Netze.
        let rc = unsafe { WlanScan(handle.0, &guid, null(), null(), null()) };
        match rc {
            ERROR_SUCCESS => Ok(()),
            POWER_STATE_INVALID => Err(RADIO_OFF.into()),
            ERROR_BUSY => Err("Der WLAN-Adapter ist gerade beschäftigt – gleich nochmal versuchen.".into()),
            ERROR_ACCESS_DENIED => Err(LOCATION_HINT.into()),
            _ => Err(format!("Der Scan konnte nicht gestartet werden (Code {rc}).")),
        }
    }

    fn profile_list(handle: HANDLE, guid: &GUID) -> Result<Vec<WifiProfile>, String> {
        let mut p: *mut WLAN_PROFILE_INFO_LIST = null_mut();
        // SAFETY: Windows legt die Liste an, WlanMem gibt sie frei.
        let rc = unsafe { WlanGetProfileList(handle, guid, null(), &mut p) };
        if rc != ERROR_SUCCESS || p.is_null() {
            return Err(format!("Die gespeicherten WLAN-Profile konnten nicht gelesen werden (Code {rc})."));
        }
        let _guard = WlanMem(p as *mut _);
        // SAFETY: C-Array mit dwNumberOfItems Einträgen, Zeiger vom Rohzeiger abgeleitet.
        let list = unsafe {
            let count = (*p).dwNumberOfItems as usize;
            let items = addr_of!((*p).ProfileInfo) as *const WLAN_PROFILE_INFO;
            std::slice::from_raw_parts(items, count)
                .iter()
                .map(|i| WifiProfile {
                    name: utf16_fixed(&i.strProfileName),
                    group_policy: i.dwFlags & WLAN_PROFILE_GROUP_POLICY != 0,
                    per_user: i.dwFlags & WLAN_PROFILE_USER != 0,
                })
                .collect()
        };
        Ok(list)
    }

    pub fn profiles(interface_id: &str) -> Result<Vec<WifiProfile>, String> {
        let (handle, guid) = open_interface(interface_id)?;
        profile_list(handle.0, &guid)
    }

    /// Profil-XML lesen (Schlüssel bleibt verschlüsselt) – nur als Sicherung im RAM,
    /// falls ein überschriebenes Profil wiederhergestellt werden muss.
    fn get_profile_xml(handle: HANDLE, guid: &GUID, name: &str) -> Option<Vec<u16>> {
        let w = wide(name);
        let mut xml: windows_sys::core::PWSTR = null_mut();
        let mut flags = 0u32; // 0 = Schlüssel NICHT im Klartext
        let mut access = 0u32;
        // SAFETY: Windows legt den String an, WlanMem gibt ihn frei.
        let rc = unsafe { WlanGetProfile(handle, guid, w.as_ptr(), null(), &mut xml, &mut flags, &mut access) };
        if rc != ERROR_SUCCESS || xml.is_null() {
            return None;
        }
        let _guard = WlanMem(xml as *mut _);
        // SAFETY: nullterminierter UTF-16-String von Windows.
        unsafe {
            let mut len = 0usize;
            while *xml.add(len) != 0 {
                len += 1;
            }
            let mut v = std::slice::from_raw_parts(xml, len).to_vec();
            v.push(0);
            Some(v)
        }
    }

    fn set_profile(handle: HANDLE, guid: &GUID, xml: &[u16]) -> Result<(), String> {
        let mut reason = 0u32;
        // SAFETY: xml ist nullterminiert; overwrite = TRUE ersetzt ein Profil mit gleichem Namen.
        let rc = unsafe { WlanSetProfile(handle, guid, 0, xml.as_ptr(), null(), 1, null(), &mut reason) };
        match rc {
            ERROR_SUCCESS => Ok(()),
            ERROR_ACCESS_DENIED => Err(
                "Windows erlaubt das Speichern des WLAN-Profils nicht (Zugriff verweigert). \
                 Evtl. sperrt eine Richtlinie das – bitte über Windows verbinden."
                    .into(),
            ),
            _ => {
                // Der Windows-Text beschreibt nur das Problem, nie den Schlüssel selbst.
                let w = if reason != 0 { reason_text(reason) } else { String::new() };
                Err(if w.is_empty() {
                    format!("Das WLAN-Profil konnte nicht gespeichert werden (Code {rc}).")
                } else {
                    format!("Das WLAN-Profil konnte nicht gespeichert werden: {w} (Code {rc})")
                })
            }
        }
    }

    fn delete_profile(handle: HANDLE, guid: &GUID, name: &str) -> Result<(), String> {
        let w = wide(name);
        // SAFETY: nullterminierter Name.
        let rc = unsafe { WlanDeleteProfile(handle, guid, w.as_ptr(), null()) };
        match rc {
            ERROR_SUCCESS => Ok(()),
            ERROR_ACCESS_DENIED => {
                Err("Zugriff verweigert – dieses Profil lässt sich nur mit Administratorrechten löschen.".into())
            }
            _ => Err(format!("Das Profil konnte nicht gelöscht werden (Code {rc}).")),
        }
    }

    // ---- Verbinden + auf das Ergebnis warten ------------------------------

    /// Ergebnis-Meldung von Windows (aus dem Benachrichtigungs-Callback).
    struct ConnEvent {
        complete: bool,
        reason: u32,
        profile: String,
    }

    struct NotifyCtx {
        guid: String,
        tx: Mutex<mpsc::Sender<ConnEvent>>,
    }

    /// Wird von Windows in einem eigenen Thread aufgerufen.
    /// Darf nicht paniken (FFI-Grenze) → keine unwrap().
    unsafe extern "system" fn on_notify(data: *mut L2_NOTIFICATION_DATA, ctx: *mut core::ffi::c_void) {
        if data.is_null() || ctx.is_null() {
            return;
        }
        let d = &*data;
        if d.NotificationSource != WLAN_NOTIFICATION_SOURCE_ACM {
            return;
        }
        let code = d.NotificationCode as i32;
        let complete = code == wlan_notification_acm_connection_complete;
        if !complete && code != wlan_notification_acm_connection_attempt_fail {
            return;
        }
        let ctx = &*(ctx as *const NotifyCtx);
        if !guid_string(&d.InterfaceGuid).eq_ignore_ascii_case(&ctx.guid) {
            return;
        }
        let min = std::mem::offset_of!(WLAN_CONNECTION_NOTIFICATION_DATA, strProfileXml);
        if d.pData.is_null() || (d.dwDataSize as usize) < min {
            return;
        }
        // Nur Reason-Code und Profilname lesen. strProfileXml wird NIE gelesen
        // (könnte den Schlüssel enthalten).
        let cd = d.pData as *const WLAN_CONNECTION_NOTIFICATION_DATA;
        let reason = std::ptr::read_unaligned(addr_of!((*cd).wlanReasonCode));
        let name = std::ptr::read_unaligned(addr_of!((*cd).strProfileName));
        if let Ok(tx) = ctx.tx.lock() {
            let _ = tx.send(ConnEvent { complete, reason, profile: utf16_fixed(&name) });
        }
    }

    /// WlanConnect mit Profil und auf "fertig" oder "gescheitert" warten.
    fn connect_and_wait(handle: &WlanHandle, guid: &GUID, profile: &str, hidden_ssid: Option<DOT11_SSID>) -> Result<(), String> {
        let (tx, rx) = mpsc::channel();
        let ctx = Box::into_raw(Box::new(NotifyCtx { guid: guid_string(guid), tx: Mutex::new(tx) }));
        let result = (|| {
            // Eigenes Handle nur für die Benachrichtigungen: WlanCloseHandle wartet,
            // bis laufende Callbacks fertig sind. Erst danach wird `ctx` freigegeben.
            let notify = open_handle()?;
            // SAFETY: ctx lebt, bis `notify` geschlossen ist (siehe unten).
            let rc = unsafe {
                WlanRegisterNotification(
                    notify.0,
                    WLAN_NOTIFICATION_SOURCE_ACM,
                    1,
                    Some(on_notify),
                    ctx as *const core::ffi::c_void,
                    null(),
                    null_mut(),
                )
            };
            if rc != ERROR_SUCCESS {
                return Err(format!("WLAN-Benachrichtigungen konnten nicht aktiviert werden (Code {rc})."));
            }
            let name = wide(profile);
            let mut ssid = hidden_ssid;
            let params = WLAN_CONNECTION_PARAMETERS {
                wlanConnectionMode: wlan_connection_mode_profile,
                strProfile: name.as_ptr(),
                pDot11Ssid: ssid.as_mut().map_or(null_mut(), |s| s as *mut DOT11_SSID),
                pDesiredBssidList: null_mut(),
                dot11BssType: dot11_BSS_type_infrastructure,
                dwFlags: 0,
            };
            // SAFETY: params zeigt auf lokale Daten, die bis nach dem Aufruf leben.
            let rc = unsafe { WlanConnect(handle.0, guid, &params, null()) };
            if rc == POWER_STATE_INVALID {
                return Err(RADIO_OFF.into());
            }
            if rc != ERROR_SUCCESS {
                return Err(format!("Windows hat den Verbindungsversuch abgelehnt (Code {rc})."));
            }
            wait_result(&rx, profile)
            // `notify` wird hier geschlossen (wartet auf laufende Callbacks)
        })();
        // SAFETY: Alle Handles mit Callback sind zu → niemand greift mehr auf ctx zu.
        drop(unsafe { Box::from_raw(ctx) });
        result
    }

    fn wait_result(rx: &mpsc::Receiver<ConnEvent>, profile: &str) -> Result<(), String> {
        let deadline = Instant::now() + Duration::from_secs(CONNECT_TIMEOUT_SECS);
        let mut last_fail: Option<u32> = None;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            match rx.recv_timeout(left) {
                Ok(ev) if ev.profile == profile => {
                    if ev.complete {
                        return if ev.reason == WLAN_REASON_CODE_SUCCESS { Ok(()) } else { Err(failure_text(ev.reason)) };
                    }
                    // Einzelner Versuch gescheitert – Windows probiert evtl. noch einen anderen AP
                    last_fail = Some(ev.reason);
                }
                Ok(_) => {} // anderes Profil (z. B. automatische Verbindung) – ignorieren
                Err(_) => break,
            }
        }
        Err(match last_fail {
            Some(r) => failure_text(r),
            None => format!(
                "Zeitüberschreitung: Windows hat die Verbindung nicht innerhalb von {CONNECT_TIMEOUT_SECS} s hergestellt."
            ),
        })
    }

    pub fn connect_profile(interface_id: &str, profile: &str) -> Result<String, String> {
        let (handle, guid) = open_interface(interface_id)?;
        let exists = profile_list(handle.0, &guid)?.iter().any(|p| p.name == profile);
        if !exists {
            return Err("Dieses Profil gibt es nicht (mehr). Bitte die Liste neu laden.".into());
        }
        connect_and_wait(&handle, &guid, profile, None)?;
        Ok(format!("Verbunden mit „{profile}“."))
    }

    pub fn connect_new(req: WifiConnectRequest) -> Result<String, String> {
        let WifiConnectRequest { interface_id, ssid, password, security, hidden } = req;
        let result = connect_new_inner(&interface_id, &ssid, &password, security, hidden);
        // Passwort-Puffer überschreiben, egal wie es ausgegangen ist
        wifiprofile::wipe_string(password);
        result
    }

    fn connect_new_inner(
        interface_id: &str,
        ssid: &str,
        password: &str,
        requested: Security,
        hidden: bool,
    ) -> Result<String, String> {
        wifiprofile::validate_ssid(ssid)?;
        let (handle, guid) = open_interface(interface_id)?;

        // Ist das Netz sichtbar, gilt die Sicherheit, die Windows meldet
        // (die Wahl im Frontend nur bei versteckten Netzen).
        let mut security = requested;
        if !hidden {
            if let Some((label, connect_as)) = visible_security(handle.0, &guid, ssid) {
                security = connect_as.ok_or_else(|| unsupported_text(label))?;
            }
        }
        wifiprofile::validate_password(security, password)?;

        let existing = profile_list(handle.0, &guid)?.into_iter().find(|p| p.name == ssid);
        if existing.as_ref().is_some_and(|p| p.group_policy) {
            return Err("Für dieses Netz gibt es ein Profil aus einer Gruppenrichtlinie (Firma). Bitte über Windows verbinden.".into());
        }
        // Sicherung des bisherigen Profils (Schlüssel verschlüsselt), falls es scheitert
        let backup = if existing.is_some() { get_profile_xml(handle.0, &guid, ssid) } else { None };

        let xml = wifiprofile::profile_xml(ssid, security, password, hidden)?;
        let wide_xml: Vec<u16> = xml.encode_utf16().chain(std::iter::once(0)).collect();
        wifiprofile::wipe_string(xml);
        let set = set_profile(handle.0, &guid, &wide_xml);
        wifiprofile::wipe_wide(wide_xml);
        set?;

        let hidden_ssid = if hidden { Some(make_ssid(ssid)) } else { None };
        match connect_and_wait(&handle, &guid, ssid, hidden_ssid) {
            Ok(()) => Ok(format!("Verbunden mit „{ssid}“. Das Profil ist in Windows gespeichert.")),
            Err(msg) => {
                // Gescheitert: kein Profil mit (vermutlich falschem) Passwort zurücklassen.
                let restored = match (&existing, backup) {
                    (None, _) => delete_profile(handle.0, &guid, ssid).is_ok(),
                    (Some(_), Some(old)) => {
                        let ok = set_profile(handle.0, &guid, &old).is_ok();
                        wifiprofile::wipe_wide(old);
                        ok
                    }
                    (Some(_), None) => false,
                };
                if existing.is_some() && !restored {
                    Err(format!("{msg} (Das bisherige Profil konnte nicht wiederhergestellt werden.)"))
                } else {
                    Err(msg)
                }
            }
        }
    }

    pub fn disconnect(interface_id: &str) -> Result<(), String> {
        let (handle, guid) = open_interface(interface_id)?;
        // SAFETY: gültiges Handle und GUID aus der Interface-Liste.
        let rc = unsafe { WlanDisconnect(handle.0, &guid, null()) };
        if rc == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(format!("Trennen fehlgeschlagen (Code {rc})."))
        }
    }

    pub fn forget(interface_id: &str, profile: &str) -> Result<(), String> {
        let (handle, guid) = open_interface(interface_id)?;
        let p = profile_list(handle.0, &guid)?
            .into_iter()
            .find(|p| p.name == profile)
            .ok_or("Dieses Profil gibt es nicht (mehr). Bitte die Liste neu laden.")?;
        if p.group_policy {
            return Err("Profile aus einer Gruppenrichtlinie (Firma) lassen sich nicht löschen.".into());
        }
        delete_profile(handle.0, &guid, &p.name)
    }
}

#[cfg(not(windows))]
mod imp {
    use super::{WifiConnectRequest, WifiInfo, WifiProfile, WifiScanResult};

    const ONLY_WINDOWS: &str = "Die WLAN-Funktionen gibt es nur unter Windows.";

    pub fn networks(_id: &str) -> Result<WifiScanResult, String> {
        Ok(WifiScanResult::default())
    }
    pub fn scan(_id: &str) -> Result<(), String> {
        Err(ONLY_WINDOWS.into())
    }
    pub fn profiles(_id: &str) -> Result<Vec<WifiProfile>, String> {
        Ok(Vec::new())
    }
    pub fn connect_profile(_id: &str, _profile: &str) -> Result<String, String> {
        Err(ONLY_WINDOWS.into())
    }
    pub fn connect_new(req: WifiConnectRequest) -> Result<String, String> {
        crate::wifiprofile::wipe_string(req.password);
        Err(ONLY_WINDOWS.into())
    }
    pub fn disconnect(_id: &str) -> Result<(), String> {
        Err(ONLY_WINDOWS.into())
    }
    pub fn forget(_id: &str, _profile: &str) -> Result<(), String> {
        Err(ONLY_WINDOWS.into())
    }

    pub fn wifi_interfaces() -> Result<Vec<WifiInfo>, String> {
        Ok(Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn baender() {
        assert_eq!(band_from_mhz(2437).as_deref(), Some("2,4 GHz"));
        assert_eq!(band_from_mhz(5180).as_deref(), Some("5 GHz"));
        assert_eq!(band_from_mhz(5975).as_deref(), Some("6 GHz"));
        assert_eq!(band_from_channel(6).as_deref(), Some("2,4 GHz"));
        assert_eq!(band_from_channel(36).as_deref(), Some("5 GHz"));
        assert_eq!(band_from_channel(0), None);
    }

    #[test]
    fn kanaele() {
        assert_eq!(channel_from_mhz(2412), Some(1));
        assert_eq!(channel_from_mhz(2472), Some(13));
        assert_eq!(channel_from_mhz(2484), Some(14));
        assert_eq!(channel_from_mhz(5180), Some(36));
        assert_eq!(channel_from_mhz(5825), Some(165));
        assert_eq!(channel_from_mhz(5955), Some(1));
        assert_eq!(channel_from_mhz(6115), Some(33));
        assert_eq!(channel_from_mhz(5935), Some(2));
        assert_eq!(channel_from_mhz(0), None);
    }

    #[test]
    fn sicherheit() {
        assert_eq!(classify_security(1, 0), ("OFFEN", Some(Security::Open)));
        assert_eq!(classify_security(1, 257).0, "WEP");
        assert_eq!(classify_security(7, 4), ("WPA2", Some(Security::Wpa2)));
        assert_eq!(classify_security(9, 4), ("WPA3", Some(Security::Wpa3)));
        assert_eq!(classify_security(6, 4), ("802.1X", None));
        assert_eq!(classify_security(11, 4), ("802.1X", None));
        assert!(unsupported_text("802.1X").starts_with("[802.1X] nicht unterstützt"));
    }

    #[test]
    fn gruende() {
        assert!(explain_reason(294_932).unwrap().contains("Passwort"));
        assert!(explain_reason(163_851).unwrap().contains("nicht erreichbar"));
        assert!(explain_reason(229_379).unwrap().contains("Zeitüberschreitung"));
        assert_eq!(explain_reason(1), None);
    }

    fn raw(ssid: &str, signal: u32, auth: i32, profile: &str, connected: bool) -> RawNetwork {
        RawNetwork {
            ssid: ssid.into(),
            signal,
            auth,
            cipher: if auth == 1 { 0 } else { 4 },
            connected,
            has_profile: !profile.is_empty(),
            profile: profile.into(),
            bss_count: 1,
        }
    }

    fn bss(ssid: &str, signal: u32, mhz: u32) -> WifiBss {
        WifiBss {
            ssid: ssid.into(),
            bssid: format!("AA-{signal:02X}"),
            signal,
            rssi_dbm: signal as i32 / 2 - 100,
            frequency_mhz: mhz,
            channel: channel_from_mhz(mhz),
            band: band_from_mhz(mhz),
        }
    }

    #[test]
    fn netze_zusammenfassen() {
        // "Heim" kommt doppelt (mit und ohne Profil) und hat 3 Access Points
        let nets = vec![
            raw("Nachbar", 40, 7, "", false),
            raw("Heim", 70, 7, "Heim", true),
            raw("Heim", 70, 7, "", false),
            raw("", 30, 7, "", false),
            raw("Firma", 55, 6, "", false),
        ];
        let aps = vec![bss("Heim", 60, 2437), bss("Heim", 85, 5180), bss("Heim", 20, 2412), bss("Nachbar", 40, 2462), bss("Geist", 10, 2412)];
        let list = merge_networks(&nets, &aps);
        let names: Vec<&str> = list.iter().map(|n| n.ssid.as_str()).collect();
        // verbunden zuerst, dann nach Signal
        assert_eq!(names, vec!["Heim", "Firma", "Nachbar", "", "Geist"]);
        let heim = &list[0];
        assert!(heim.connected && heim.saved);
        assert_eq!(heim.profile, "Heim");
        assert_eq!(heim.ap_count, 3);
        assert_eq!(heim.signal, 85);
        assert_eq!(heim.channel, Some(36));
        assert_eq!(heim.band.as_deref(), Some("5 GHz"));
        assert_eq!(list[1].security, "802.1X");
        assert_eq!(list[1].connect_as, None);
        assert!(list[3].hidden);
        assert_eq!(list[4].security, "?");
        assert_eq!(names_hint(&list), None);
        assert!(names_hint(&[]).is_some());
        assert!(names_hint(&list[3..4]).is_some()); // nur versteckte → Namen fehlen
    }
}
