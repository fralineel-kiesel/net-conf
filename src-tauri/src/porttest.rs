//! Port-Test: Ist ein TCP-Port auf einem Host erreichbar?
//!
//! Wie `Test-NetConnection -Port` in PowerShell: Es wird eine TCP-Verbindung
//! aufgebaut und sofort wieder geschlossen. Nur Standardbibliothek, kein
//! Windows-spezifischer Code. Drei mögliche Ergebnisse:
//! * offen       – Verbindung klappt
//! * geschlossen – der Host antwortet mit "Reset" (dort lauscht nichts)
//! * gefiltert   – keine Antwort innerhalb der Wartezeit (meist eine Firewall)

use serde::{Deserialize, Serialize};
use std::io::ErrorKind;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

const MAX_PORTS: usize = 32;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortTestRequest {
    pub host: String,
    pub ports: Vec<u16>,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortResult {
    pub port: u16,
    /// "open" | "closed" | "filtered" | "error"
    pub status: &'static str,
    pub ms: Option<u32>,
    pub message: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortTestResponse {
    pub host: String,
    /// Die tatsächlich getestete IP-Adresse
    pub address: String,
    pub results: Vec<PortResult>,
}

pub fn run(req: &PortTestRequest) -> Result<PortTestResponse, String> {
    let host = crate::runner::validate_target(&req.host)?;

    let mut ports: Vec<u16> = req.ports.clone();
    ports.sort_unstable();
    ports.dedup();
    if ports.is_empty() {
        return Err("Bitte mindestens einen Port angeben.".into());
    }
    if ports.contains(&0) {
        return Err("Port 0 ist ungültig (erlaubt: 1–65535).".into());
    }
    if ports.len() > MAX_PORTS {
        return Err(format!("Bitte höchstens {MAX_PORTS} Ports auf einmal testen."));
    }
    let timeout = Duration::from_millis(req.timeout_ms.unwrap_or(2000).clamp(200, 10_000));

    // Namen auflösen. IPv4 bevorzugen – wie die meisten Windows-Tools.
    let addrs: Vec<SocketAddr> = (host.as_str(), 0)
        .to_socket_addrs()
        .map_err(|_| format!("Der Host „{host}“ wurde nicht gefunden. Bitte Namen prüfen."))?
        .collect();
    let ip = addrs
        .iter()
        .find(|a| a.is_ipv4())
        .or(addrs.first())
        .map(|a| a.ip())
        .ok_or_else(|| format!("Für „{host}“ gibt es keine IP-Adresse."))?;

    // Alle Ports gleichzeitig testen (je ein Thread), damit es schnell geht.
    let results = std::thread::scope(|scope| {
        let handles: Vec<_> = ports
            .iter()
            .map(|&port| scope.spawn(move || test_port(SocketAddr::new(ip, port), timeout)))
            .collect();
        handles
            .into_iter()
            .zip(&ports)
            .map(|(h, &port)| {
                h.join().unwrap_or(PortResult {
                    port,
                    status: "error",
                    ms: None,
                    message: Some("Interner Fehler".into()),
                })
            })
            .collect()
    });

    Ok(PortTestResponse { host, address: ip.to_string(), results })
}

fn test_port(addr: SocketAddr, timeout: Duration) -> PortResult {
    let start = Instant::now();
    let result = TcpStream::connect_timeout(&addr, timeout);
    let ms = start.elapsed().as_millis().min(u32::MAX as u128) as u32;
    let port = addr.port();
    match result {
        Ok(stream) => {
            let _ = stream.shutdown(std::net::Shutdown::Both);
            PortResult { port, status: "open", ms: Some(ms), message: None }
        }
        Err(e) if e.kind() == ErrorKind::ConnectionRefused => {
            PortResult { port, status: "closed", ms: Some(ms), message: None }
        }
        Err(e) if matches!(e.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock) => {
            PortResult { port, status: "filtered", ms: None, message: None }
        }
        Err(e) => PortResult { port, status: "error", ms: None, message: Some(e.to_string()) },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn offen_und_geschlossen() {
        // Ein lokaler Server auf einem freien Port = offen
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let open_port = listener.local_addr().unwrap().port();
        // Einen weiteren freien Port holen und sofort wieder freigeben = geschlossen
        let closed_port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();

        let r = run(&PortTestRequest {
            host: "127.0.0.1".into(),
            ports: vec![open_port, closed_port, open_port],
            timeout_ms: Some(1000),
        })
        .unwrap();
        assert_eq!(r.address, "127.0.0.1");
        assert_eq!(r.results.len(), 2, "doppelte Ports werden zusammengefasst");
        let status = |p: u16| r.results.iter().find(|x| x.port == p).unwrap().status;
        assert_eq!(status(open_port), "open");
        assert_eq!(status(closed_port), "closed");
    }

    #[test]
    fn eingaben_pruefen() {
        let req = |host: &str, ports: Vec<u16>| PortTestRequest { host: host.into(), ports, timeout_ms: None };
        assert!(run(&req("127.0.0.1", vec![])).is_err());
        assert!(run(&req("127.0.0.1", vec![0])).is_err());
        assert!(run(&req("127.0.0.1", (1..=40).collect())).is_err());
        assert!(run(&req("-x", vec![80])).is_err());
        assert!(run(&req("a;b", vec![80])).is_err());
    }
}
