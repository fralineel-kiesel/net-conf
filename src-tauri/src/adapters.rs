//! Netzwerkadapter auslesen.
//!
//! Unter Windows über die IP-Helper-API (`GetAdaptersAddresses` +
//! `GetAdaptersInfo`) – bewusst NICHT über den Text von `ipconfig /all`,
//! weil dieser je nach Windows-Sprache anders aussieht.
//!
//! * `GetAdaptersAddresses` liefert fast alles (Name, IPv4/IPv6, Gateway,
//!   DNS, DHCP-Flag, DHCP-Server, DNS-Suffix, Status, MAC).
//! * `GetAdaptersInfo` (ältere API, nur IPv4) liefert zusätzlich die
//!   absoluten Lease-Zeiten (Beginn/Ablauf), die die neue API nicht hat.
//!   Die beiden Listen werden über den Adapter-GUID verknüpft.

use serde::Serialize;

/// Eine IPv4-Adresse mit Subnetzmaske.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ipv4Entry {
    pub address: String,
    pub subnet_mask: String,
}

/// Alle Infos zu einem Adapter, so wie das Frontend sie anzeigt.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterInfo {
    /// Interne ID (GUID), stabil pro Adapter.
    pub id: String,
    /// Anzeigename, z. B. "WLAN" oder "Ethernet 2".
    pub name: String,
    /// Hardware-Beschreibung, z. B. "Intel(R) Wi-Fi 6 AX201".
    pub description: String,
    /// true = verbunden (OperStatus "Up").
    pub connected: bool,
    /// MAC-Adresse im Windows-Format "AA-BB-CC-DD-EE-FF" (leer, falls keine).
    pub mac: String,
    pub ipv4: Vec<Ipv4Entry>,
    pub ipv6: Vec<String>,
    pub gateways: Vec<String>,
    pub dns_servers: Vec<String>,
    pub dhcp_enabled: bool,
    pub dhcp_server: Option<String>,
    /// Unix-Zeitstempel in Sekunden (UTC), falls verfügbar.
    pub lease_obtained: Option<i64>,
    pub lease_expires: Option<i64>,
    pub dns_suffix: String,
}

/// Öffentliche Funktion: Adapterliste holen (plattformabhängig).
pub fn list_adapters() -> Result<Vec<AdapterInfo>, String> {
    imp::list_adapters()
}

/// Name und Interface-Metriken eines Netzwerk-Interfaces (für ARP/Routen).
/// (Wird nur unter Windows benutzt – daher dort keine Warnung.)
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, Clone)]
pub struct InterfaceRef {
    pub name: String,
    pub ipv4_metric: u32,
    pub ipv6_metric: u32,
}

/// Interface-Index → Name/Metrik. Enthält auch Loopback und getrennte Adapter.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn interface_map() -> std::collections::HashMap<u32, InterfaceRef> {
    imp::interface_map()
}

// ---------------------------------------------------------------------------
// Windows-Implementierung
// ---------------------------------------------------------------------------
#[cfg(windows)]
mod imp {
    use super::{AdapterInfo, InterfaceRef, Ipv4Entry};
    use std::collections::HashMap;
    use std::ffi::CStr;
    use std::net::{Ipv4Addr, Ipv6Addr};
    use windows_sys::Win32::Foundation::{ERROR_BUFFER_OVERFLOW, NO_ERROR};
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetAdaptersAddresses, GetAdaptersInfo, GAA_FLAG_INCLUDE_GATEWAYS, GAA_FLAG_SKIP_ANYCAST,
        GAA_FLAG_SKIP_MULTICAST, IF_TYPE_SOFTWARE_LOOPBACK, IP_ADAPTER_ADDRESSES_LH,
        IP_ADAPTER_DHCP_ENABLED, IP_ADAPTER_INFO,
    };
    use windows_sys::Win32::NetworkManagement::Ndis::IfOperStatusUp;
    use windows_sys::Win32::Networking::WinSock::{
        AF_INET, AF_INET6, AF_UNSPEC, SOCKADDR_IN, SOCKADDR_IN6, SOCKET_ADDRESS,
    };

    /// Lease-Infos aus der alten API, Schlüssel = Adapter-GUID.
    struct LeaseInfo {
        obtained: Option<i64>,
        expires: Option<i64>,
    }

    pub fn list_adapters() -> Result<Vec<AdapterInfo>, String> {
        let leases = read_leases();
        // None = Windows meldet "keine Adapter vorhanden".
        let Some(buf) = call_get_adapters_addresses()? else {
            return Ok(Vec::new());
        };

        let mut result = Vec::new();
        // SAFETY: Der Puffer stammt von GetAdaptersAddresses und enthält eine
        // verkettete Liste. Alle Zeiger zeigen in denselben Puffer, der bis
        // zum Ende dieser Funktion lebt. Wir lesen nur.
        unsafe {
            let mut cur = buf.as_ptr() as *const IP_ADAPTER_ADDRESSES_LH;
            while !cur.is_null() {
                let a = &*cur;
                if a.IfType != IF_TYPE_SOFTWARE_LOOPBACK {
                    result.push(convert_adapter(a, &leases));
                }
                cur = a.Next;
            }
        }

        // Verbundene Adapter zuerst, danach alphabetisch.
        result.sort_by(|x, y| {
            y.connected
                .cmp(&x.connected)
                .then_with(|| x.name.to_lowercase().cmp(&y.name.to_lowercase()))
        });
        Ok(result)
    }

    pub fn interface_map() -> HashMap<u32, InterfaceRef> {
        let mut map = HashMap::new();
        let Ok(Some(buf)) = call_get_adapters_addresses() else {
            return map;
        };
        // SAFETY: wie in list_adapters – verkettete Liste im Puffer, nur lesend.
        unsafe {
            let mut cur = buf.as_ptr() as *const IP_ADAPTER_ADDRESSES_LH;
            while !cur.is_null() {
                let a = &*cur;
                let info = InterfaceRef {
                    name: pwstr_to_string(a.FriendlyName),
                    ipv4_metric: a.Ipv4Metric,
                    ipv6_metric: a.Ipv6Metric,
                };
                // IPv4- und IPv6-Index sind meist gleich, aber nicht immer.
                let idx4 = a.Anonymous1.Anonymous.IfIndex;
                if idx4 != 0 {
                    map.insert(idx4, info.clone());
                }
                if a.Ipv6IfIndex != 0 {
                    map.entry(a.Ipv6IfIndex).or_insert(info);
                }
                cur = a.Next;
            }
        }
        map
    }

    /// Ruft GetAdaptersAddresses auf. Die Funktion verlangt einen Puffer,
    /// dessen Grösse man vorher nicht kennt – daher: mit 16 KB starten und
    /// bei ERROR_BUFFER_OVERFLOW mit der gemeldeten Grösse erneut versuchen.
    ///
    /// Der Puffer ist ein `Vec<u64>`, damit er 8-Byte-ausgerichtet ist
    /// (die Strukturen enthalten u64-Felder).
    fn call_get_adapters_addresses() -> Result<Option<Vec<u64>>, String> {
        let flags = GAA_FLAG_INCLUDE_GATEWAYS | GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST;
        let mut size: u32 = 16 * 1024;
        for _ in 0..4 {
            let mut buf: Vec<u64> = vec![0; (size as usize).div_ceil(8)];
            // SAFETY: Puffer und Grösse passen zusammen; Windows schreibt nur
            // innerhalb von `size` Bytes.
            let rc = unsafe {
                GetAdaptersAddresses(
                    AF_UNSPEC as u32,
                    flags,
                    std::ptr::null(),
                    buf.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH,
                    &mut size,
                )
            };
            match rc {
                NO_ERROR => return Ok(Some(buf)),
                ERROR_BUFFER_OVERFLOW => continue, // `size` wurde angepasst
                // ERROR_NO_DATA (232): keine Adapter vorhanden
                232 => return Ok(None),
                other => return Err(format!("GetAdaptersAddresses fehlgeschlagen (Code {other})")),
            }
        }
        Err("GetAdaptersAddresses: Puffergrösse konnte nicht ermittelt werden".into())
    }

    /// Liest Lease-Beginn/-Ablauf über GetAdaptersInfo. Fehler sind hier
    /// nicht schlimm – dann fehlen eben nur die Lease-Zeiten.
    fn read_leases() -> HashMap<String, LeaseInfo> {
        let mut map = HashMap::new();
        let mut size: u32 = 16 * 1024;
        for _ in 0..4 {
            let mut buf: Vec<u64> = vec![0; (size as usize).div_ceil(8)];
            // SAFETY: wie oben.
            let rc = unsafe { GetAdaptersInfo(buf.as_mut_ptr() as *mut IP_ADAPTER_INFO, &mut size) };
            if rc == ERROR_BUFFER_OVERFLOW {
                continue;
            }
            if rc != NO_ERROR {
                return map;
            }
            // SAFETY: verkettete Liste innerhalb von `buf`, nur lesend.
            unsafe {
                let mut cur = buf.as_ptr() as *const IP_ADAPTER_INFO;
                while !cur.is_null() {
                    let info = &*cur;
                    let guid = CStr::from_ptr(info.AdapterName.as_ptr() as *const _)
                        .to_string_lossy()
                        .to_string();
                    let valid = |t: i64| if info.DhcpEnabled != 0 && t > 0 { Some(t) } else { None };
                    map.insert(
                        guid.to_uppercase(),
                        LeaseInfo {
                            obtained: valid(info.LeaseObtained),
                            expires: valid(info.LeaseExpires),
                        },
                    );
                    cur = info.Next;
                }
            }
            return map;
        }
        map
    }

    /// Wandelt einen Eintrag der Windows-Liste in unsere AdapterInfo um.
    ///
    /// SAFETY: `a` muss aus einem gültigen GetAdaptersAddresses-Puffer stammen.
    unsafe fn convert_adapter(a: &IP_ADAPTER_ADDRESSES_LH, leases: &HashMap<String, LeaseInfo>) -> AdapterInfo {
        let id = if a.AdapterName.is_null() {
            String::new()
        } else {
            CStr::from_ptr(a.AdapterName as *const _).to_string_lossy().to_string()
        };

        // MAC-Adresse: nur die ersten `PhysicalAddressLength` Bytes sind gültig.
        let mac_len = (a.PhysicalAddressLength as usize).min(a.PhysicalAddress.len());
        let mac = a.PhysicalAddress[..mac_len]
            .iter()
            .map(|b| format!("{b:02X}"))
            .collect::<Vec<_>>()
            .join("-");

        // Unicast-Adressen (eigene IPs) durchgehen.
        let mut ipv4 = Vec::new();
        let mut ipv6 = Vec::new();
        let mut u = a.FirstUnicastAddress;
        while !u.is_null() {
            let ua = &*u;
            match sockaddr_to_string(&ua.Address) {
                Some(Ip::V4(ip)) => ipv4.push(Ipv4Entry {
                    address: ip.to_string(),
                    subnet_mask: prefix_to_mask(ua.OnLinkPrefixLength).to_string(),
                }),
                Some(Ip::V6(ip)) => ipv6.push(ip.to_string()),
                None => {}
            }
            u = ua.Next;
        }

        let mut gateways = Vec::new();
        let mut g = a.FirstGatewayAddress;
        while !g.is_null() {
            if let Some(ip) = sockaddr_to_string(&(*g).Address) {
                gateways.push(ip.to_string());
            }
            g = (*g).Next;
        }

        let mut dns_servers = Vec::new();
        let mut d = a.FirstDnsServerAddress;
        while !d.is_null() {
            if let Some(ip) = sockaddr_to_string(&(*d).Address) {
                // fec0:0:0:ffff::1 usw. sind veraltete "Site-local"-Platzhalter,
                // die Windows bei fehlendem IPv6-DNS anzeigt – ausblenden.
                let s = ip.to_string();
                if !s.starts_with("fec0:") {
                    dns_servers.push(s);
                }
            }
            d = (*d).Next;
        }

        // Flags ist eine Union – das Feld `Flags` ist die normale Lesart.
        let dhcp_enabled = a.Anonymous2.Flags & IP_ADAPTER_DHCP_ENABLED != 0;
        let dhcp_server = if dhcp_enabled {
            sockaddr_to_string(&a.Dhcpv4Server).map(|ip| ip.to_string())
        } else {
            None
        };

        let lease = leases.get(&id.to_uppercase());

        AdapterInfo {
            name: pwstr_to_string(a.FriendlyName),
            description: pwstr_to_string(a.Description),
            connected: a.OperStatus == IfOperStatusUp,
            mac,
            ipv4,
            ipv6,
            gateways,
            dns_servers,
            dhcp_enabled,
            dhcp_server,
            lease_obtained: lease.and_then(|l| l.obtained),
            lease_expires: lease.and_then(|l| l.expires),
            dns_suffix: pwstr_to_string(a.DnsSuffix),
            id,
        }
    }

    enum Ip {
        V4(Ipv4Addr),
        V6(Ipv6Addr),
    }

    impl std::fmt::Display for Ip {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self {
                Ip::V4(ip) => write!(f, "{ip}"),
                Ip::V6(ip) => write!(f, "{ip}"),
            }
        }
    }

    /// SOCKET_ADDRESS (Windows-Socketadresse) in eine Rust-IP umwandeln.
    ///
    /// SAFETY: `sa.lpSockaddr` muss null sein oder auf eine gültige Adresse zeigen.
    unsafe fn sockaddr_to_string(sa: &SOCKET_ADDRESS) -> Option<Ip> {
        if sa.lpSockaddr.is_null() {
            return None;
        }
        match (*sa.lpSockaddr).sa_family {
            AF_INET => {
                let sin = &*(sa.lpSockaddr as *const SOCKADDR_IN);
                // S_addr liegt in Netzwerk-Byte-Reihenfolge im Speicher,
                // to_ne_bytes() gibt also direkt a.b.c.d zurück.
                Some(Ip::V4(Ipv4Addr::from(sin.sin_addr.S_un.S_addr.to_ne_bytes())))
            }
            AF_INET6 => {
                let sin6 = &*(sa.lpSockaddr as *const SOCKADDR_IN6);
                Some(Ip::V6(Ipv6Addr::from(sin6.sin6_addr.u.Byte)))
            }
            _ => None,
        }
    }

    /// Präfixlänge (z. B. 24) in Subnetzmaske (255.255.255.0) umrechnen.
    fn prefix_to_mask(prefix: u8) -> Ipv4Addr {
        let p = prefix.min(32) as u32;
        let mask: u32 = if p == 0 { 0 } else { u32::MAX << (32 - p) };
        Ipv4Addr::from(mask)
    }

    /// Nullterminierten UTF-16-String (PWSTR) in Rust-String umwandeln.
    ///
    /// SAFETY: `p` muss null sein oder auf einen nullterminierten String zeigen.
    unsafe fn pwstr_to_string(p: *mut u16) -> String {
        if p.is_null() {
            return String::new();
        }
        let mut len = 0usize;
        while *p.add(len) != 0 {
            len += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(p, len))
    }
}

// ---------------------------------------------------------------------------
// Fallback für Nicht-Windows-Systeme (nur damit das Projekt überall baut)
// ---------------------------------------------------------------------------
#[cfg(not(windows))]
mod imp {
    use super::{AdapterInfo, InterfaceRef, Ipv4Entry};

    #[allow(dead_code)]
    pub fn interface_map() -> std::collections::HashMap<u32, InterfaceRef> {
        std::collections::HashMap::new()
    }

    pub fn list_adapters() -> Result<Vec<AdapterInfo>, String> {
        Ok(vec![AdapterInfo {
            id: "{MOCK-0000}".into(),
            name: "Mock-Ethernet".into(),
            description: "Testadapter (kein Windows)".into(),
            connected: true,
            mac: "00-11-22-33-44-55".into(),
            ipv4: vec![Ipv4Entry {
                address: "192.168.1.50".into(),
                subnet_mask: "255.255.255.0".into(),
            }],
            ipv6: vec!["fe80::1".into()],
            gateways: vec!["192.168.1.1".into()],
            dns_servers: vec!["192.168.1.1".into()],
            dhcp_enabled: true,
            dhcp_server: Some("192.168.1.1".into()),
            lease_obtained: None,
            lease_expires: None,
            dns_suffix: "local".into(),
        }])
    }
}
