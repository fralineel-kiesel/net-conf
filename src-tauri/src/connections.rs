//! Verbindungen und Prozesse (wie `netstat -ano`, aber über die Windows-API).
//!
//! * `GetExtendedTcpTable` / `GetExtendedUdpTable` mit PID, je für IPv4 und IPv6
//! * Prozessname per PID: `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` +
//!   `QueryFullProcessImageNameW`. Ohne Zugriff (fremde/geschützte Prozesse,
//!   ohne Adminrechte) steht "(kein Zugriff)" – das ist kein Fehler.
//! * PID 0 und 4 heissen "System".
//!
//! Bewusst NICHT eingebaut: "Prozess beenden".

// Die reine Logik hier nutzt nur der Windows-Teil – unter Linux (cargo test)
// wäre sie sonst "unbenutzt". Massgeblich ist clippy für das Windows-Target.
#![cfg_attr(not(windows), allow(dead_code))]

use serde::Serialize;
use std::net::IpAddr;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    /// "TCP" oder "UDP"
    pub proto: &'static str,
    /// 4 oder 6
    pub family: u8,
    pub local_addr: String,
    pub local_port: u16,
    /// leer bei UDP (keine Gegenstelle)
    pub remote_addr: String,
    pub remote_port: u16,
    /// TCP-Zustand wie bei netstat (LISTEN, ESTABLISHED …), leer bei UDP
    pub state: &'static str,
    pub pid: u32,
    pub process: String,
}

/// TCP-Zustand (MIB_TCP_STATE) → Name wie bei netstat.
pub fn tcp_state(state: u32) -> &'static str {
    match state {
        1 => "CLOSED",
        2 => "LISTEN",
        3 => "SYN_SENT",
        4 => "SYN_RECEIVED",
        5 => "ESTABLISHED",
        6 => "FIN_WAIT_1",
        7 => "FIN_WAIT_2",
        8 => "CLOSE_WAIT",
        9 => "CLOSING",
        10 => "LAST_ACK",
        11 => "TIME_WAIT",
        12 => "DELETE_TCB",
        _ => "UNBEKANNT",
    }
}

/// Port aus dem DWORD der Tabelle: Netzwerk-Byte-Reihenfolge in den unteren 16 Bit.
pub fn port_from_dword(dw: u32) -> u16 {
    u16::from_be(dw as u16)
}

/// Anzeigename für Sonder-PIDs.
pub fn special_process(pid: u32) -> Option<&'static str> {
    match pid {
        0 | 4 => Some("System"),
        _ => None,
    }
}

pub fn list() -> Result<Vec<Connection>, String> {
    imp::list()
}

/// Reverse-DNS für EINE Adresse (nur auf Klick). Fragt den System-DNS-Server
/// (wie die DNS-Abfrage unter Tests). `None` = kein Name.
pub fn reverse(address: &str) -> Result<Option<String>, String> {
    // Zonen-Index von Link-Local-Adressen ("fe80::1%12") gehört nicht zur Adresse
    let ip: IpAddr = address
        .trim()
        .trim_matches(|c| c == '[' || c == ']')
        .split('%')
        .next()
        .unwrap_or_default()
        .parse()
        .map_err(|_| "Ungültige IP-Adresse.".to_string())?;
    if ip.is_unspecified() {
        return Err("Für diese Adresse gibt es keinen Namen.".into());
    }
    let resp = crate::dns::query(&crate::dns::DnsRequest {
        name: ip.to_string(),
        record_type: "PTR".into(),
        server: None,
    })?;
    Ok(resp
        .answers
        .iter()
        .find(|a| a.record_type == "PTR")
        .map(|a| a.data.trim_end_matches('.').to_string()))
}

#[cfg(windows)]
mod imp {
    use super::{port_from_dword, special_process, tcp_state, Connection};
    use std::collections::HashMap;
    use std::net::{Ipv4Addr, Ipv6Addr};
    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_INSUFFICIENT_BUFFER, NO_ERROR};
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, GetExtendedUdpTable, MIB_TCP6ROW_OWNER_PID, MIB_TCP6TABLE_OWNER_PID,
        MIB_TCPROW_OWNER_PID, MIB_TCPTABLE_OWNER_PID, MIB_UDP6ROW_OWNER_PID, MIB_UDP6TABLE_OWNER_PID,
        MIB_UDPROW_OWNER_PID, MIB_UDPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_ALL, UDP_TABLE_OWNER_PID,
    };
    use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_INET6};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    /// Ruft GetExtendedTcpTable/-UdpTable mit wachsendem Puffer auf (Grösse vorher unbekannt).
    /// Puffer als Vec<u64> → 8-Byte-ausgerichtet.
    fn fetch(call: impl Fn(*mut core::ffi::c_void, *mut u32) -> u32, what: &str) -> Result<Vec<u64>, String> {
        let mut size: u32 = 64 * 1024;
        for _ in 0..5 {
            let mut buf: Vec<u64> = vec![0; (size as usize).div_ceil(8)];
            let rc = call(buf.as_mut_ptr() as *mut _, &mut size);
            match rc {
                NO_ERROR => return Ok(buf),
                // Zwischen zwei Aufrufen können Verbindungen dazukommen → etwas Reserve
                ERROR_INSUFFICIENT_BUFFER => size = size.saturating_add(16 * 1024),
                other => return Err(format!("{what} konnte nicht gelesen werden (Code {other}).")),
            }
        }
        Err(format!("{what}: Puffergrösse konnte nicht ermittelt werden."))
    }

    /// Prozessname zur PID, mit Cache (viele Verbindungen gehören zum selben Prozess).
    fn process_name(pid: u32, cache: &mut HashMap<u32, String>) -> String {
        if let Some(name) = special_process(pid) {
            return name.into();
        }
        cache
            .entry(pid)
            .or_insert_with(|| {
                // SAFETY: OpenProcess liefert 0/NULL bei Fehler; Handle wird geschlossen.
                unsafe {
                    let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
                    if h.is_null() {
                        return "(kein Zugriff)".into();
                    }
                    let mut buf = [0u16; 1024];
                    let mut len = buf.len() as u32;
                    let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len);
                    CloseHandle(h);
                    if ok == 0 {
                        return "(kein Zugriff)".into();
                    }
                    let path = String::from_utf16_lossy(&buf[..(len as usize).min(buf.len())]);
                    // Nur der Dateiname ("chrome.exe" statt "C:\Program Files\…\chrome.exe")
                    path.rsplit('\\').next().unwrap_or(&path).to_string()
                }
            })
            .clone()
    }

    fn v4(dw: u32) -> String {
        // Adresse steht in Netzwerk-Byte-Reihenfolge im Speicher
        Ipv4Addr::from(dw.to_ne_bytes()).to_string()
    }

    fn v6(bytes: &[u8; 16], scope: u32) -> String {
        let ip = Ipv6Addr::from(*bytes);
        // Link-Local (fe80::) mit Zonen-Index wie bei netstat: fe80::1%12
        if scope != 0 && (ip.segments()[0] & 0xffc0) == 0xfe80 {
            format!("{ip}%{scope}")
        } else {
            ip.to_string()
        }
    }

    pub fn list() -> Result<Vec<Connection>, String> {
        let mut out = Vec::new();
        let mut cache = HashMap::new();

        // ---- TCP IPv4 ----
        // SAFETY (alle vier Blöcke): Der Puffer stammt von fetch() und enthält
        // eine Tabelle mit dwNumEntries Zeilen direkt hintereinander. Der Zeiger
        // auf die Zeilen wird vom Rohzeiger abgeleitet (addr_of!), nicht von einer Referenz.
        let buf = fetch(
            |p, s| unsafe { GetExtendedTcpTable(p, s, 0, AF_INET as u32, TCP_TABLE_OWNER_PID_ALL, 0) },
            "Die TCP-Tabelle (IPv4)",
        )?;
        unsafe {
            let t = buf.as_ptr() as *const MIB_TCPTABLE_OWNER_PID;
            let rows = std::ptr::addr_of!((*t).table) as *const MIB_TCPROW_OWNER_PID;
            for r in std::slice::from_raw_parts(rows, (*t).dwNumEntries as usize) {
                let listen = r.dwState == 2;
                out.push(Connection {
                    proto: "TCP",
                    family: 4,
                    local_addr: v4(r.dwLocalAddr),
                    local_port: port_from_dword(r.dwLocalPort),
                    remote_addr: v4(r.dwRemoteAddr),
                    // Bei LISTEN steht im Remote-Port Müll – netstat zeigt 0
                    remote_port: if listen { 0 } else { port_from_dword(r.dwRemotePort) },
                    state: tcp_state(r.dwState),
                    pid: r.dwOwningPid,
                    process: process_name(r.dwOwningPid, &mut cache),
                });
            }
        }

        // ---- TCP IPv6 ----
        let buf = fetch(
            |p, s| unsafe { GetExtendedTcpTable(p, s, 0, AF_INET6 as u32, TCP_TABLE_OWNER_PID_ALL, 0) },
            "Die TCP-Tabelle (IPv6)",
        )?;
        unsafe {
            let t = buf.as_ptr() as *const MIB_TCP6TABLE_OWNER_PID;
            let rows = std::ptr::addr_of!((*t).table) as *const MIB_TCP6ROW_OWNER_PID;
            for r in std::slice::from_raw_parts(rows, (*t).dwNumEntries as usize) {
                let listen = r.dwState == 2;
                out.push(Connection {
                    proto: "TCP",
                    family: 6,
                    local_addr: v6(&r.ucLocalAddr, r.dwLocalScopeId),
                    local_port: port_from_dword(r.dwLocalPort),
                    remote_addr: v6(&r.ucRemoteAddr, r.dwRemoteScopeId),
                    remote_port: if listen { 0 } else { port_from_dword(r.dwRemotePort) },
                    state: tcp_state(r.dwState),
                    pid: r.dwOwningPid,
                    process: process_name(r.dwOwningPid, &mut cache),
                });
            }
        }

        // ---- UDP IPv4 ----
        let buf = fetch(
            |p, s| unsafe { GetExtendedUdpTable(p, s, 0, AF_INET as u32, UDP_TABLE_OWNER_PID, 0) },
            "Die UDP-Tabelle (IPv4)",
        )?;
        unsafe {
            let t = buf.as_ptr() as *const MIB_UDPTABLE_OWNER_PID;
            let rows = std::ptr::addr_of!((*t).table) as *const MIB_UDPROW_OWNER_PID;
            for r in std::slice::from_raw_parts(rows, (*t).dwNumEntries as usize) {
                out.push(Connection {
                    proto: "UDP",
                    family: 4,
                    local_addr: v4(r.dwLocalAddr),
                    local_port: port_from_dword(r.dwLocalPort),
                    remote_addr: String::new(),
                    remote_port: 0,
                    state: "",
                    pid: r.dwOwningPid,
                    process: process_name(r.dwOwningPid, &mut cache),
                });
            }
        }

        // ---- UDP IPv6 ----
        let buf = fetch(
            |p, s| unsafe { GetExtendedUdpTable(p, s, 0, AF_INET6 as u32, UDP_TABLE_OWNER_PID, 0) },
            "Die UDP-Tabelle (IPv6)",
        )?;
        unsafe {
            let t = buf.as_ptr() as *const MIB_UDP6TABLE_OWNER_PID;
            let rows = std::ptr::addr_of!((*t).table) as *const MIB_UDP6ROW_OWNER_PID;
            for r in std::slice::from_raw_parts(rows, (*t).dwNumEntries as usize) {
                out.push(Connection {
                    proto: "UDP",
                    family: 6,
                    local_addr: v6(&r.ucLocalAddr, r.dwLocalScopeId),
                    local_port: port_from_dword(r.dwLocalPort),
                    remote_addr: String::new(),
                    remote_port: 0,
                    state: "",
                    pid: r.dwOwningPid,
                    process: process_name(r.dwOwningPid, &mut cache),
                });
            }
        }
        Ok(out)
    }
}

#[cfg(not(windows))]
mod imp {
    use super::Connection;

    pub fn list() -> Result<Vec<Connection>, String> {
        Err("Die Verbindungsliste gibt es nur unter Windows.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zustaende_und_ports() {
        assert_eq!(tcp_state(2), "LISTEN");
        assert_eq!(tcp_state(5), "ESTABLISHED");
        assert_eq!(tcp_state(11), "TIME_WAIT");
        assert_eq!(tcp_state(99), "UNBEKANNT");
        // Port 443 = 0x01BB steht als Bytes BB 01 → DWORD-Wert 0xBB01 auf Little Endian
        assert_eq!(port_from_dword(u32::from(u16::to_be(443))), 443);
        assert_eq!(special_process(4), Some("System"));
        assert_eq!(special_process(0), Some("System"));
        assert_eq!(special_process(1234), None);
    }

    #[test]
    fn reverse_prueft_eingabe() {
        assert!(reverse("kein-ip").is_err());
        assert!(reverse("0.0.0.0").is_err());
        assert!(reverse("::").is_err());
        assert!(reverse("%12").is_err());
    }
}
