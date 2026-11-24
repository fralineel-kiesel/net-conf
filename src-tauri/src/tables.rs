//! ARP-Tabelle (Nachbarn) und Routing-Tabelle über die Windows-API.
//!
//! Wie bei den Adaptern: NICHT den Text von `arp -a` oder `route print`
//! parsen (sprachabhängig), sondern `GetIpNetTable2` / `GetIpForwardTable2`.
//! Beide liefern IPv4 und IPv6 in einem Aufruf.

use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NeighborEntry {
    pub address: String,
    pub family: u8,
    /// MAC-Adresse "AA-BB-CC-DD-EE-FF" (leer, wenn noch unbekannt)
    pub mac: String,
    pub interface: String,
    /// Zustand auf Deutsch, z. B. "erreichbar", "veraltet"
    pub state: &'static str,
    /// true = statischer Eintrag (bei `arp -a`: "statisch")
    pub permanent: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteEntry {
    /// Ziel mit Präfix, z. B. "0.0.0.0/0" oder "192.168.1.0/24"
    pub destination: String,
    pub prefix_len: u8,
    /// Gateway; leer = "Auf Verbindung" (direkt erreichbar, ohne Router)
    pub gateway: String,
    pub interface: String,
    /// Wirksame Metrik = Routen-Metrik + Interface-Metrik (wie bei route print)
    pub metric: u32,
    pub family: u8,
}

pub fn arp_table() -> Result<Vec<NeighborEntry>, String> {
    imp::arp_table()
}

pub fn route_table() -> Result<Vec<RouteEntry>, String> {
    imp::route_table()
}

#[cfg(windows)]
mod imp {
    use super::{NeighborEntry, RouteEntry};
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
    use windows_sys::Win32::Foundation::NO_ERROR;
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        FreeMibTable, GetIpForwardTable2, GetIpNetTable2, MIB_IPFORWARD_ROW2, MIB_IPFORWARD_TABLE2,
        MIB_IPNET_ROW2, MIB_IPNET_TABLE2,
    };
    use windows_sys::Win32::Networking::WinSock::{
        NlnsDelay, NlnsIncomplete, NlnsPermanent, NlnsProbe, NlnsReachable, NlnsStale, AF_INET, AF_INET6,
        AF_UNSPEC, SOCKADDR_INET,
    };

    /// SOCKADDR_INET (Union aus IPv4/IPv6) → Rust-IP.
    ///
    /// SAFETY: `sa` muss eine gültige, von Windows gefüllte Adresse sein.
    unsafe fn to_ip(sa: &SOCKADDR_INET) -> Option<IpAddr> {
        match sa.si_family {
            AF_INET => Some(IpAddr::V4(Ipv4Addr::from(sa.Ipv4.sin_addr.S_un.S_addr.to_ne_bytes()))),
            AF_INET6 => Some(IpAddr::V6(Ipv6Addr::from(sa.Ipv6.sin6_addr.u.Byte))),
            _ => None,
        }
    }

    fn family(ip: &IpAddr) -> u8 {
        if ip.is_ipv4() {
            4
        } else {
            6
        }
    }

    // Die Windows-Konstanten heissen "NlnsReachable" usw. (nicht GROSS) – das ist hier gewollt.
    #[allow(non_upper_case_globals)]
    fn state_text(state: i32) -> &'static str {
        match state {
            NlnsReachable => "erreichbar",
            NlnsStale => "veraltet",
            NlnsDelay => "verzögert",
            NlnsProbe => "wird geprüft",
            NlnsIncomplete => "unvollständig",
            NlnsPermanent => "statisch",
            _ => "unerreichbar",
        }
    }

    fn if_name(map: &std::collections::HashMap<u32, crate::adapters::InterfaceRef>, index: u32) -> String {
        map.get(&index).map(|i| i.name.clone()).unwrap_or_else(|| format!("Interface {index}"))
    }

    pub fn arp_table() -> Result<Vec<NeighborEntry>, String> {
        let names = crate::adapters::interface_map();
        let mut table: *mut MIB_IPNET_TABLE2 = std::ptr::null_mut();
        // SAFETY: Windows legt die Tabelle an; wir geben sie mit FreeMibTable frei.
        let rc = unsafe { GetIpNetTable2(AF_UNSPEC, &mut table) };
        if rc != NO_ERROR || table.is_null() {
            return Err(format!("ARP-Tabelle konnte nicht gelesen werden (Code {rc})."));
        }
        let mut out = Vec::new();
        // SAFETY: Die Tabelle besteht aus NumEntries Zeilen direkt hintereinander.
        // Der Zeiger auf die Zeilen wird vom Rohzeiger abgeleitet (addr_of!),
        // nicht von einer Referenz, die nur das erste Element abdecken würde.
        unsafe {
            let count = (*table).NumEntries as usize;
            let rows_ptr = std::ptr::addr_of!((*table).Table) as *const MIB_IPNET_ROW2;
            for row in std::slice::from_raw_parts(rows_ptr, count) {
                let Some(ip) = to_ip(&row.Address) else { continue };
                let len = (row.PhysicalAddressLength as usize).min(row.PhysicalAddress.len());
                let mac = row.PhysicalAddress[..len]
                    .iter()
                    .map(|b| format!("{b:02X}"))
                    .collect::<Vec<_>>()
                    .join("-");
                out.push(NeighborEntry {
                    address: ip.to_string(),
                    family: family(&ip),
                    mac,
                    interface: if_name(&names, row.InterfaceIndex),
                    state: state_text(row.State),
                    permanent: row.State == NlnsPermanent,
                });
            }
            FreeMibTable(table as *const core::ffi::c_void);
        }
        // Sortierung: Interface, dann IPv4 vor IPv6, dann Adresse
        out.sort_by(|a, b| {
            (a.interface.as_str(), a.family, sort_key(&a.address))
                .cmp(&(b.interface.as_str(), b.family, sort_key(&b.address)))
        });
        Ok(out)
    }

    pub fn route_table() -> Result<Vec<RouteEntry>, String> {
        let ifaces = crate::adapters::interface_map();
        let mut table: *mut MIB_IPFORWARD_TABLE2 = std::ptr::null_mut();
        // SAFETY: wie bei arp_table.
        let rc = unsafe { GetIpForwardTable2(AF_UNSPEC, &mut table) };
        if rc != NO_ERROR || table.is_null() {
            return Err(format!("Routing-Tabelle konnte nicht gelesen werden (Code {rc})."));
        }
        let mut out = Vec::new();
        // SAFETY: wie bei arp_table.
        unsafe {
            let count = (*table).NumEntries as usize;
            let rows_ptr = std::ptr::addr_of!((*table).Table) as *const MIB_IPFORWARD_ROW2;
            for row in std::slice::from_raw_parts(rows_ptr, count) {
                let Some(dest) = to_ip(&row.DestinationPrefix.Prefix) else { continue };
                let gateway = match to_ip(&row.NextHop) {
                    Some(gw) if !gw.is_unspecified() => gw.to_string(),
                    _ => String::new(), // 0.0.0.0 bzw. :: = direkt verbunden
                };
                let iface = ifaces.get(&row.InterfaceIndex);
                let if_metric = match (iface, dest.is_ipv4()) {
                    (Some(i), true) => i.ipv4_metric,
                    (Some(i), false) => i.ipv6_metric,
                    (None, _) => 0,
                };
                out.push(RouteEntry {
                    destination: format!("{dest}/{}", row.DestinationPrefix.PrefixLength),
                    prefix_len: row.DestinationPrefix.PrefixLength,
                    gateway,
                    interface: if_name(&ifaces, row.InterfaceIndex),
                    metric: row.Metric.saturating_add(if_metric),
                    family: family(&dest),
                });
            }
            FreeMibTable(table as *const core::ffi::c_void);
        }
        // IPv4 vor IPv6, dann nach Zieladresse und Präfixlänge (wie route print)
        out.sort_by(|a, b| {
            let ka = (a.family, sort_key(a.destination.split('/').next().unwrap_or("")), a.prefix_len);
            let kb = (b.family, sort_key(b.destination.split('/').next().unwrap_or("")), b.prefix_len);
            ka.cmp(&kb)
        });
        Ok(out)
    }

    /// IP als Zahl, damit 192.168.1.10 nach 192.168.1.9 sortiert wird.
    fn sort_key(ip: &str) -> u128 {
        match ip.parse::<IpAddr>() {
            Ok(IpAddr::V4(v4)) => u32::from(v4) as u128,
            Ok(IpAddr::V6(v6)) => u128::from(v6),
            Err(_) => u128::MAX,
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::{NeighborEntry, RouteEntry};

    pub fn arp_table() -> Result<Vec<NeighborEntry>, String> {
        Err("Die ARP-Tabelle ist nur unter Windows verfügbar.".into())
    }

    pub fn route_table() -> Result<Vec<RouteEntry>, String> {
        Err("Die Routing-Tabelle ist nur unter Windows verfügbar.".into())
    }
}
