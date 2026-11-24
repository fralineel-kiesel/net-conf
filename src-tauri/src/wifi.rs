//! WLAN-Infos (SSID, Signal, Kanal, Band …) über die Windows-WLAN-API (wlanapi.dll).
//!
//! Ablauf: WlanOpenHandle → WlanEnumInterfaces → pro Interface
//! WlanQueryInterface (aktuelle Verbindung, Kanal) → WlanGetNetworkBssList
//! (für Frequenz und Signalstärke in dBm) → alles mit WlanFreeMemory freigeben.
//!
//! Wichtig ab Windows 11 24H2: Für SSID/BSSID verlangt Windows, dass Desktop-Apps
//! Standortzugriff haben (Einstellungen → Datenschutz → Standort). Sonst kommt
//! "Zugriff verweigert" – wir zeigen dann eine verständliche Meldung.

use serde::Serialize;

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
}

#[cfg(not(windows))]
mod imp {
    use super::WifiInfo;

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
}
