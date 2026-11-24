//! Native Pings über die Windows-API (`IcmpSendEcho` aus iphlpapi.dll).
//!
//! Warum nicht ping.exe? Für Health-Check, Monitor, LAN-Scan und WoL brauchen
//! wir viele kurze Pings und nur Zahlen (Latenz, TTL). ping.exe zu starten
//! kostet jedes Mal einen Prozess, und seine Ausgabe ist sprachabhängig.
//! `IcmpSendEcho` braucht – anders als "Raw Sockets" – KEINE Adminrechte.
//!
//! Der Ping-Test unter "Tests → Ping" nutzt weiterhin ping.exe (runner.rs),
//! damit man dort die echte Windows-Ausgabe sieht.
//!
//! Nur IPv4: `IcmpSendEcho` kann kein IPv6 (dafür gäbe es `Icmp6SendEcho2`,
//! das wir bewusst weglassen, um den Code klein zu halten).

use serde::Serialize;
use std::net::{IpAddr, Ipv4Addr, ToSocketAddrs};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// Ergebnis eines einzelnen Pings.
/// (Ausserhalb von Windows entsteht nur `Error` – daher dort keine Warnung.)
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Echo {
    /// Antwort erhalten: Laufzeit in ms (0 = unter 1 ms) und TTL.
    Reply { rtt_ms: u32, ttl: u8 },
    /// Keine Antwort innerhalb der Wartezeit.
    Timeout,
    /// Ein Router meldet "nicht erreichbar" (Netz/Host) o. Ä.
    Unreachable(String),
    /// Ping konnte gar nicht gesendet werden.
    Error(String),
}

impl Echo {
    /// Latenz in ms, falls eine Antwort kam.
    pub fn rtt(&self) -> Option<u32> {
        match self {
            Echo::Reply { rtt_ms, .. } => Some(*rtt_ms),
            _ => None,
        }
    }
}

/// Wartezeit begrenzen: unter 100 ms ist sinnlos, über 5 s blockiert zu lange.
pub fn clamp_timeout(ms: u32) -> u32 {
    ms.clamp(100, 5000)
}

/// Einen Ping senden. Blockiert höchstens etwa `timeout_ms`
/// (Ausnahme: im eigenen Subnetz kann Windows bis zu ~3 s auf ARP warten).
pub fn ping(ip: Ipv4Addr, timeout_ms: u32) -> Echo {
    imp::ping(ip, clamp_timeout(timeout_ms))
}

// ---------------------------------------------------------------------------
// Hilfen: Namen auflösen, begrenzte Parallelität
// ---------------------------------------------------------------------------

/// Ziel (IPv4 oder Hostname) in eine IPv4-Adresse auflösen.
/// Nutzt den System-Resolver (wie ping.exe). Das Ziel muss vorher mit
/// `runner::validate_target` geprüft sein.
pub fn resolve_ipv4(target: &str) -> Result<Ipv4Addr, String> {
    if let Ok(ip) = target.parse::<Ipv4Addr>() {
        return Ok(ip);
    }
    if target.parse::<IpAddr>().is_ok() {
        return Err("IPv6-Adressen werden hier nicht unterstützt (nur IPv4).".into());
    }
    let addrs = resolve_with_timeout(target, Duration::from_secs(3))?;
    addrs
        .iter()
        .find_map(|a| match a {
            IpAddr::V4(v4) => Some(*v4),
            IpAddr::V6(_) => None,
        })
        .ok_or_else(|| format!("Für „{target}“ gibt es keine IPv4-Adresse."))
}

/// Namen über den System-Resolver auflösen – mit Zeitlimit.
///
/// Die Standardbibliothek (`getaddrinfo`) kennt kein Zeitlimit. Darum läuft die
/// Abfrage in einem eigenen Thread; wir warten nur `timeout` lang auf das
/// Ergebnis. Hängt der Resolver, läuft der Thread im Hintergrund zu Ende und
/// sein Ergebnis wird verworfen.
pub fn resolve_with_timeout(name: &str, timeout: Duration) -> Result<Vec<IpAddr>, String> {
    let (tx, rx) = mpsc::channel();
    let owned = name.to_string();
    std::thread::spawn(move || {
        let result = (owned.as_str(), 0u16)
            .to_socket_addrs()
            .map(|it| it.map(|sa| sa.ip()).collect::<Vec<_>>());
        let _ = tx.send(result); // Empfänger ist evtl. schon weg – egal
    });
    match rx.recv_timeout(timeout) {
        Ok(Ok(list)) if !list.is_empty() => Ok(list),
        Ok(_) => Err(format!("Der Name „{name}“ konnte nicht aufgelöst werden.")),
        Err(_) => Err(format!(
            "Zeitüberschreitung bei der Namensauflösung von „{name}“ ({} s).",
            timeout.as_secs_f32()
        )),
    }
}

/// Wendet `f` auf alle Elemente an, mit höchstens `max_parallel` Threads
/// gleichzeitig. Die Reihenfolge der Ergebnisse entspricht der Eingabe.
///
/// Arbeitsweise: `max_parallel` Arbeiter holen sich reihum das nächste
/// Element (gemeinsamer Zähler). So ist nie ein Arbeiter untätig, solange
/// noch Arbeit da ist.
pub fn parallel_map<T, R, F>(items: &[T], max_parallel: usize, f: F) -> Vec<R>
where
    T: Sync,
    R: Send,
    F: Fn(&T) -> R + Sync,
{
    let workers = max_parallel.max(1).min(items.len());
    let next = AtomicUsize::new(0);
    let mut results: Vec<(usize, R)> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..workers)
            .map(|_| {
                scope.spawn(|| {
                    let mut mine = Vec::new();
                    loop {
                        let i = next.fetch_add(1, Ordering::SeqCst);
                        let Some(item) = items.get(i) else { break };
                        mine.push((i, f(item)));
                    }
                    mine
                })
            })
            .collect();
        // panic=abort im Release: ein join-Fehler kann praktisch nicht auftreten
        handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
    });
    results.sort_by_key(|(i, _)| *i);
    results.into_iter().map(|(_, r)| r).collect()
}

// ---------------------------------------------------------------------------
// Tauri-Command: ein einzelner Ping (für WoL-Check)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PingResult {
    pub address: String,
    /// "ok" | "timeout" | "unreachable" | "error"
    pub status: &'static str,
    pub rtt_ms: Option<u32>,
    pub ttl: Option<u8>,
    pub message: Option<String>,
}

impl PingResult {
    pub fn from_echo(ip: Ipv4Addr, echo: Echo) -> PingResult {
        let address = ip.to_string();
        match echo {
            Echo::Reply { rtt_ms, ttl } => {
                PingResult { address, status: "ok", rtt_ms: Some(rtt_ms), ttl: Some(ttl), message: None }
            }
            Echo::Timeout => PingResult { address, status: "timeout", rtt_ms: None, ttl: None, message: None },
            Echo::Unreachable(m) => {
                PingResult { address, status: "unreachable", rtt_ms: None, ttl: None, message: Some(m) }
            }
            Echo::Error(m) => PingResult { address, status: "error", rtt_ms: None, ttl: None, message: Some(m) },
        }
    }
}

/// Ziel prüfen, auflösen, einmal pingen. Blockierend → über `spawn_blocking` aufrufen.
pub fn ping_target(target: &str, timeout_ms: u32) -> Result<PingResult, String> {
    let target = crate::runner::validate_target(target)?;
    let ip = resolve_ipv4(&target)?;
    Ok(PingResult::from_echo(ip, ping(ip, timeout_ms)))
}

/// Ergebnis der System-Namensauflösung (Health-Check, Stufe 5).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveResult {
    pub addresses: Vec<String>,
    pub elapsed_ms: u32,
}

pub fn resolve_system(name: &str, timeout_ms: u32) -> Result<ResolveResult, String> {
    let name = crate::dns::validate_name(name)?;
    let start = Instant::now();
    let list = resolve_with_timeout(&name, Duration::from_millis(timeout_ms.clamp(500, 10_000) as u64))?;
    Ok(ResolveResult {
        addresses: list.iter().map(|ip| ip.to_string()).collect(),
        elapsed_ms: start.elapsed().as_millis().min(u32::MAX as u128) as u32,
    })
}

// ---------------------------------------------------------------------------
// Windows: IcmpCreateFile → IcmpSendEcho → IcmpCloseHandle
// ---------------------------------------------------------------------------
#[cfg(windows)]
mod imp {
    use super::Echo;
    use std::net::Ipv4Addr;
    use windows_sys::Win32::Foundation::{GetLastError, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        IcmpCloseHandle, IcmpCreateFile, IcmpSendEcho, ICMP_ECHO_REPLY, IP_DEST_HOST_UNREACHABLE,
        IP_DEST_NET_UNREACHABLE, IP_REQ_TIMED_OUT, IP_SUCCESS, IP_TTL_EXPIRED_TRANSIT,
    };

    /// Schliesst das ICMP-Handle automatisch ("Drop-Guard"), auch bei frühem return.
    struct IcmpHandle(HANDLE);
    impl Drop for IcmpHandle {
        fn drop(&mut self) {
            // SAFETY: Handle stammt von IcmpCreateFile und wird genau einmal geschlossen.
            unsafe {
                IcmpCloseHandle(self.0);
            }
        }
    }

    /// 32 Bytes Nutzdaten – wie bei ping.exe.
    const PAYLOAD: &[u8; 32] = b"abcdefghijklmnopqrstuvwabcdefghi";

    fn status_text(status: u32) -> String {
        match status {
            IP_DEST_HOST_UNREACHABLE => "Zielhost nicht erreichbar".into(),
            IP_DEST_NET_UNREACHABLE => "Zielnetz nicht erreichbar".into(),
            IP_TTL_EXPIRED_TRANSIT => "TTL abgelaufen (Routing-Schleife?)".into(),
            other => format!("ICMP-Status {other}"),
        }
    }

    pub fn ping(ip: Ipv4Addr, timeout_ms: u32) -> Echo {
        // Jeder Aufruf bekommt sein eigenes Handle – so können mehrere Threads
        // gleichzeitig pingen, ohne sich ein Handle zu teilen.
        // SAFETY: IcmpCreateFile hat keine Parameter; Fehler = INVALID_HANDLE_VALUE.
        let raw = unsafe { IcmpCreateFile() };
        if raw == INVALID_HANDLE_VALUE || raw.is_null() {
            return Echo::Error("ICMP konnte nicht geöffnet werden.".into());
        }
        let handle = IcmpHandle(raw);

        // Antwortpuffer: laut Doku mind. sizeof(ICMP_ECHO_REPLY) + Daten + 8 Bytes
        // (+ Platz für eine ICMP-Fehlermeldung). Vec<u64> = 8-Byte-ausgerichtet.
        let reply_size = std::mem::size_of::<ICMP_ECHO_REPLY>() + PAYLOAD.len() + 8 + 64;
        let mut buf: Vec<u64> = vec![0; reply_size.div_ceil(8)];

        // Die Zieladresse erwartet Windows in Netzwerk-Byte-Reihenfolge,
        // d. h. die Bytes a.b.c.d genau so im Speicher → from_ne_bytes(octets).
        let dest = u32::from_ne_bytes(ip.octets());

        // SAFETY: Alle Zeiger zeigen auf gültigen Speicher, der bis nach dem
        // Aufruf lebt; reply_size passt zum Puffer (buf ist mind. so gross).
        let count = unsafe {
            IcmpSendEcho(
                handle.0,
                dest,
                PAYLOAD.as_ptr() as *const core::ffi::c_void,
                PAYLOAD.len() as u16,
                std::ptr::null(), // Standard-Optionen (TTL 128)
                buf.as_mut_ptr() as *mut core::ffi::c_void,
                (buf.len() * 8) as u32,
                timeout_ms,
            )
        };

        if count == 0 {
            // SAFETY: direkt nach dem fehlgeschlagenen Aufruf im selben Thread.
            let err = unsafe { GetLastError() };
            return match err {
                IP_REQ_TIMED_OUT => Echo::Timeout,
                IP_DEST_HOST_UNREACHABLE | IP_DEST_NET_UNREACHABLE => Echo::Unreachable(status_text(err)),
                other => Echo::Error(format!("Ping fehlgeschlagen (Code {other}).")),
            };
        }

        // SAFETY: Bei count > 0 steht am Pufferanfang mindestens eine
        // ICMP_ECHO_REPLY-Struktur. read_unaligned ist hier nicht nötig
        // (Puffer ist ausgerichtet), schadet aber nicht.
        let reply: ICMP_ECHO_REPLY = unsafe { std::ptr::read_unaligned(buf.as_ptr() as *const ICMP_ECHO_REPLY) };
        if reply.Status == IP_SUCCESS {
            // Sicherheitshalber: Antwort muss vom Ziel selbst kommen.
            if reply.Address != dest {
                return Echo::Unreachable(format!(
                    "Antwort von {} statt vom Ziel",
                    Ipv4Addr::from(reply.Address.to_ne_bytes())
                ));
            }
            Echo::Reply { rtt_ms: reply.RoundTripTime, ttl: reply.Options.Ttl }
        } else if reply.Status == IP_REQ_TIMED_OUT {
            Echo::Timeout
        } else {
            Echo::Unreachable(status_text(reply.Status))
        }
    }
}

// ---------------------------------------------------------------------------
// Andere Systeme: kein ICMP ohne Root-Rechte – einfache Fehlermeldung.
// ---------------------------------------------------------------------------
#[cfg(not(windows))]
mod imp {
    use super::Echo;
    use std::net::Ipv4Addr;

    pub fn ping(_ip: Ipv4Addr, _timeout_ms: u32) -> Echo {
        Echo::Error("Native Pings gibt es nur unter Windows.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn parallel_map_reihenfolge_und_grenze() {
        let items: Vec<u32> = (0..100).collect();
        let active = AtomicUsize::new(0);
        let peak = AtomicUsize::new(0);
        let out = parallel_map(&items, 8, |&x| {
            let now = active.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(now, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(2));
            active.fetch_sub(1, Ordering::SeqCst);
            x * 2
        });
        assert_eq!(out, items.iter().map(|x| x * 2).collect::<Vec<_>>());
        assert!(peak.load(Ordering::SeqCst) <= 8, "höchstens 8 gleichzeitig");
        assert!(parallel_map(&Vec::<u32>::new(), 4, |&x| x).is_empty());
    }

    #[test]
    fn timeout_grenzen() {
        assert_eq!(clamp_timeout(0), 100);
        assert_eq!(clamp_timeout(500), 500);
        assert_eq!(clamp_timeout(60_000), 5000);
    }

    #[test]
    fn aufloesen() {
        assert_eq!(resolve_ipv4("192.168.1.1").unwrap(), Ipv4Addr::new(192, 168, 1, 1));
        assert!(resolve_ipv4("::1").is_err());
        // localhost geht ohne Netz
        assert!(resolve_with_timeout("localhost", Duration::from_secs(3)).is_ok());
        // ungültige Eingaben lehnt ping_target schon vor dem Auflösen ab
        assert!(ping_target("-n 5 x", 500).is_err());
        assert!(ping_target("a;b", 500).is_err());
    }
}
