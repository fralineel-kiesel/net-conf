//! LAN-Scanner: Welche Geräte sind im eigenen Subnetz?
//!
//! Sicherheit (Schutz vor Missbrauch als Portscanner/Netz-Scanner):
//! * Es gibt KEINEN frei wählbaren Bereich. Das Frontend schickt nur
//!   Adaptername + eigene IPv4-Adresse; das Subnetz berechnet das Backend
//!   aus der echten Adapterliste von Windows.
//! * Erlaubt sind nur private Netze (RFC 1918: 10/8, 172.16/12, 192.168/16)
//!   und Link-Local (169.254/16), höchstens /22 (= 1022 Adressen).
//! * Begrenzte Parallelität (64), es läuft immer nur ein Scan.
//!
//! Methode:
//! 1. `SendARP` – fragt per ARP "wer hat diese IP?". Im lokalen Subnetz
//!    antwortet jedes Gerät auf ARP, auch wenn seine Firewall Pings blockiert.
//!    (SendARP hat kein einstellbares Zeitlimit; Windows wartet bei leeren
//!    Adressen ca. 1–3 s – daher die Parallelität.)
//! 2. Nur für gefundene Geräte: ICMP-Ping (500 ms) für die Latenz.
//! 3. Reverse-DNS (PTR beim DNS-Server des Adapters, 1 s) für den Namen.
//!
//! Events an das Frontend:
//! * `lan-host`     { scanId, host }            (mehrmals pro Gerät: erst MAC, dann Latenz/Name)
//! * `lan-progress` { scanId, done, total }
//! * `lan-finished` { scanId, cancelled, found, elapsedMs }

use serde::Serialize;
use std::net::{IpAddr, Ipv4Addr};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

/// Grösstes erlaubtes Subnetz: /22
pub const MIN_PREFIX: u8 = 22;
pub const SCAN_PARALLEL: usize = 64;
const PING_TIMEOUT_MS: u32 = 500;
const PTR_TIMEOUT: Duration = Duration::from_millis(1000);

// ---------------------------------------------------------------------------
// Subnetz-Regeln (reine Funktionen, getestet)
// ---------------------------------------------------------------------------

/// Subnetzmaske "255.255.255.0" → 24. Nur gültige (zusammenhängende) Masken.
pub fn mask_to_prefix(mask: &str) -> Option<u8> {
    let m = u32::from(mask.parse::<Ipv4Addr>().ok()?);
    let prefix = m.leading_ones();
    // Nach den Einsen dürfen nur noch Nullen kommen
    if m.checked_shl(prefix).unwrap_or(0) != 0 {
        return None;
    }
    Some(prefix as u8)
}

/// Ist das ein erlaubtes Netz? (privat nach RFC 1918 oder Link-Local)
pub fn is_allowed_net(ip: Ipv4Addr) -> bool {
    ip.is_private() || ip.is_link_local()
}

/// Alle Host-Adressen des Subnetzes (ohne Netz- und Broadcast-Adresse),
/// oder eine verständliche Meldung, warum nicht gescannt wird.
pub fn scan_range(ip: Ipv4Addr, prefix: u8) -> Result<Vec<Ipv4Addr>, String> {
    if !is_allowed_net(ip) {
        return Err(format!(
            "{ip} liegt nicht in einem privaten Netz. Gescannt werden nur private Netze \
             (10.x, 172.16–31.x, 192.168.x) und Link-Local (169.254.x)."
        ));
    }
    if prefix < MIN_PREFIX {
        return Err(format!(
            "Das Subnetz /{prefix} ist zu gross ({} Adressen). Erlaubt ist höchstens /{MIN_PREFIX} (1022 Adressen).",
            (1u64 << (32 - prefix as u32)) - 2
        ));
    }
    if prefix > 30 {
        return Err(format!("Im Subnetz /{prefix} gibt es keine weiteren Geräte."));
    }
    let mask = u32::MAX << (32 - prefix as u32);
    let net = u32::from(ip) & mask;
    let bcast = net | !mask;
    Ok((net + 1..bcast).map(Ipv4Addr::from).collect())
}

/// Eigene IPv4 + Präfix eines Adapters – nur wenn der Adapter (exakt) existiert,
/// verbunden ist und die Adresse wirklich zu ihm gehört.
pub fn adapter_ipv4(adapter: &str, address: &str) -> Result<(Ipv4Addr, u8), String> {
    let (ip, prefix, _) = adapter_details(adapter, address)?;
    Ok((ip, prefix))
}

/// Wie `adapter_ipv4`, zusätzlich die Adapterdaten (MAC, Gateway, DNS).
fn adapter_details(adapter: &str, address: &str) -> Result<(Ipv4Addr, u8, crate::adapters::AdapterInfo), String> {
    crate::runner::validate_adapter(adapter)?;
    let list = crate::adapters::list_adapters()?;
    let a = list.into_iter().find(|a| a.name == adapter).ok_or_else(|| format!("Adapter \"{adapter}\" wurde nicht gefunden."))?;
    if !a.connected {
        return Err(format!("Der Adapter \"{adapter}\" ist nicht verbunden."));
    }
    let entry = a
        .ipv4
        .iter()
        .find(|e| e.address == address)
        .ok_or_else(|| format!("Die Adresse {address} gehört nicht zum Adapter \"{adapter}\"."))?;
    let ip: Ipv4Addr = entry.address.parse().map_err(|_| "Ungültige Adapter-Adresse.".to_string())?;
    let prefix = mask_to_prefix(&entry.subnet_mask).ok_or("Ungültige Subnetzmaske.")?;
    Ok((ip, prefix, a))
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanHost {
    pub ip: String,
    pub mac: String,
    pub latency_ms: Option<u32>,
    pub hostname: Option<String>,
    /// true, solange Latenz/Name noch ermittelt werden
    pub pending: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostEvent {
    scan_id: u32,
    host: LanHost,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    scan_id: u32,
    done: u32,
    total: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FinishedEvent {
    scan_id: u32,
    cancelled: bool,
    found: u32,
    elapsed_ms: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanStarted {
    /// z. B. "192.168.1.0/24"
    pub network: String,
    pub total: u32,
}

/// Tauri-State: der laufende Scan (Abbruch-Schalter), höchstens einer.
#[derive(Default)]
pub struct LanScanner {
    current: Mutex<Option<Arc<AtomicBool>>>,
}

impl LanScanner {
    pub fn cancel_all(&self) {
        if let Some(c) = self.current.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            c.store(true, Ordering::SeqCst);
        }
    }
}

#[tauri::command]
pub fn lan_scan_start(
    app: AppHandle,
    scanner: State<'_, LanScanner>,
    scan_id: u32,
    adapter: String,
    address: String,
) -> Result<ScanStarted, String> {
    if !imp::AVAILABLE {
        return Err("Der LAN-Scan ist nur unter Windows verfügbar.".into());
    }
    let (src, prefix, info) = adapter_details(&adapter, &address)?;
    let hosts = scan_range(src, prefix)?;
    let total = hosts.len() as u32;
    let mask = u32::MAX << (32 - prefix as u32);
    let network = format!("{}/{prefix}", Ipv4Addr::from(u32::from(src) & mask));

    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut cur = scanner.current.lock().unwrap_or_else(|e| e.into_inner());
        if cur.is_some() {
            return Err("Es läuft bereits ein Scan.".into());
        }
        *cur = Some(cancel.clone());
    }

    // DNS-Server für Reverse-Lookups: der erste IPv4-DNS des Adapters
    let dns: Option<IpAddr> = info.dns_servers.iter().find_map(|s| s.parse::<Ipv4Addr>().ok()).map(IpAddr::V4);
    let own_mac = info.mac.clone();

    std::thread::spawn(move || {
        let start = Instant::now();
        let done = AtomicU32::new(0);
        let found = AtomicU32::new(0);
        let emit_host = |host: LanHost| {
            let _ = app.emit("lan-host", HostEvent { scan_id, host });
        };

        crate::icmp::parallel_map(&hosts, SCAN_PARALLEL, |&ip| {
            if cancel.load(Ordering::SeqCst) {
                return;
            }
            let mac = if ip == src {
                // Eigene Adresse: MAC aus der Adapterliste (SendARP auf sich selbst ist unzuverlässig)
                Some(own_mac.clone())
            } else {
                imp::arp(ip, src).map(|m| crate::wol::format_mac(&m))
            };
            if let Some(mac) = mac {
                found.fetch_add(1, Ordering::SeqCst);
                let mut host = LanHost { ip: ip.to_string(), mac, latency_ms: None, hostname: None, pending: true };
                emit_host(host.clone());
                if ip == src {
                    host.latency_ms = Some(0);
                } else if !cancel.load(Ordering::SeqCst) {
                    host.latency_ms = crate::icmp::ping(ip, PING_TIMEOUT_MS).rtt();
                }
                if let (Some(server), false) = (dns, cancel.load(Ordering::SeqCst)) {
                    host.hostname = crate::dns::reverse_lookup(IpAddr::V4(ip), server, PTR_TIMEOUT);
                }
                host.pending = false;
                emit_host(host);
            }
            let n = done.fetch_add(1, Ordering::SeqCst) + 1;
            let _ = app.emit("lan-progress", ProgressEvent { scan_id, done: n, total });
        });

        let cancelled = cancel.load(Ordering::SeqCst);
        {
            use tauri::Manager;
            *app.state::<LanScanner>().current.lock().unwrap_or_else(|e| e.into_inner()) = None;
        }
        let _ = app.emit(
            "lan-finished",
            FinishedEvent {
                scan_id,
                cancelled,
                found: found.load(Ordering::SeqCst),
                elapsed_ms: start.elapsed().as_millis().min(u32::MAX as u128) as u32,
            },
        );
    });

    Ok(ScanStarted { network, total })
}

#[tauri::command]
pub fn lan_scan_cancel(scanner: State<'_, LanScanner>) {
    scanner.cancel_all();
}

// ---------------------------------------------------------------------------
// Windows: SendARP
// ---------------------------------------------------------------------------
#[cfg(windows)]
mod imp {
    use std::net::Ipv4Addr;
    use windows_sys::Win32::Foundation::NO_ERROR;
    use windows_sys::Win32::NetworkManagement::IpHelper::SendARP;

    pub const AVAILABLE: bool = true;

    /// ARP-Anfrage für `ip` über das Interface mit der Adresse `src`.
    /// Liefert die MAC oder None (keine Antwort).
    pub fn arp(ip: Ipv4Addr, src: Ipv4Addr) -> Option<[u8; 6]> {
        // Platz für 8 Bytes (Doku: "array of ULONG of length 2"), gültig sind 6.
        let mut buf = [0u32; 2];
        let mut len: u32 = 8;
        // Adressen in Netzwerk-Byte-Reihenfolge (Bytes a.b.c.d im Speicher).
        let dest = u32::from_ne_bytes(ip.octets());
        let from = u32::from_ne_bytes(src.octets());
        // SAFETY: buf hat 8 Bytes, len sagt Windows genau das.
        let rc = unsafe { SendARP(dest, from, buf.as_mut_ptr() as *mut core::ffi::c_void, &mut len) };
        if rc != NO_ERROR || len < 6 {
            return None;
        }
        let mut bytes = [0u8; 8];
        bytes[..4].copy_from_slice(&buf[0].to_ne_bytes());
        bytes[4..].copy_from_slice(&buf[1].to_ne_bytes());
        let mut mac = [0u8; 6];
        mac.copy_from_slice(&bytes[..6]);
        if mac == [0; 6] {
            return None;
        }
        Some(mac)
    }
}

#[cfg(not(windows))]
mod imp {
    use std::net::Ipv4Addr;

    pub const AVAILABLE: bool = false;

    pub fn arp(_ip: Ipv4Addr, _src: Ipv4Addr) -> Option<[u8; 6]> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masken() {
        assert_eq!(mask_to_prefix("255.255.255.0"), Some(24));
        assert_eq!(mask_to_prefix("255.255.252.0"), Some(22));
        assert_eq!(mask_to_prefix("255.255.255.255"), Some(32));
        assert_eq!(mask_to_prefix("0.0.0.0"), Some(0));
        assert_eq!(mask_to_prefix("255.0.255.0"), None, "Lücke in der Maske");
        assert_eq!(mask_to_prefix("kaputt"), None);
    }

    #[test]
    fn erlaubte_netze() {
        let r = scan_range(Ipv4Addr::new(192, 168, 1, 42), 24).unwrap();
        assert_eq!(r.len(), 254);
        assert_eq!(r[0], Ipv4Addr::new(192, 168, 1, 1));
        assert_eq!(r[253], Ipv4Addr::new(192, 168, 1, 254));
        assert_eq!(scan_range(Ipv4Addr::new(10, 0, 5, 9), 22).unwrap().len(), 1022);
        assert_eq!(scan_range(Ipv4Addr::new(172, 20, 0, 1), 30).unwrap().len(), 2);
        assert!(scan_range(Ipv4Addr::new(169, 254, 10, 1), 24).is_ok(), "Link-Local mit /24");
    }

    #[test]
    fn verbotene_netze() {
        // öffentlich
        assert!(scan_range(Ipv4Addr::new(8, 8, 8, 8), 24).is_err());
        assert!(scan_range(Ipv4Addr::new(100, 64, 0, 1), 24).is_err(), "CGNAT ist nicht RFC 1918");
        assert!(scan_range(Ipv4Addr::new(172, 32, 0, 1), 24).is_err());
        // zu gross
        assert!(scan_range(Ipv4Addr::new(10, 0, 0, 1), 8).is_err());
        assert!(scan_range(Ipv4Addr::new(192, 168, 0, 1), 21).is_err());
        assert!(scan_range(Ipv4Addr::new(169, 254, 1, 1), 16).is_err(), "Link-Local /16 ist zu gross");
        // keine Hosts
        assert!(scan_range(Ipv4Addr::new(192, 168, 1, 1), 31).is_err());
    }

    #[test]
    fn adapter_pruefung() {
        // Unter Linux liefert adapters.rs einen Mock-Adapter (192.168.1.50/24).
        assert_eq!(adapter_ipv4("Mock-Ethernet", "192.168.1.50").unwrap(), (Ipv4Addr::new(192, 168, 1, 50), 24));
        assert!(adapter_ipv4("Mock-Ethernet", "192.168.1.51").is_err(), "fremde Adresse");
        assert!(adapter_ipv4("Gibt-es-nicht", "192.168.1.50").is_err());
        assert!(adapter_ipv4("Mock-Ethernet & calc", "192.168.1.50").is_err());
    }
}
