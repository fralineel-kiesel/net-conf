//! Kleiner DNS-Client (UDP) – fragt einen DNS-Server direkt, genau wie `nslookup`.
//!
//! Warum selbst gebaut statt `nslookup` aufrufen? Die Ausgabe von nslookup ist
//! sprachabhängig (deutsches Windows!) und schwer zu parsen. Ein DNS-Paket ist
//! dagegen ein klar definiertes Binärformat (RFC 1035). Der Code hier ist
//! reines Rust ohne `unsafe` und läuft auf jedem System – auch in den Tests.
//!
//! Aufbau eines DNS-Pakets:
//!   Header (12 Bytes) | Frage(n) | Antworten | Authority | Additional
//! Namen werden als Labels gespeichert: 3"www" 7"example" 3"com" 0.
//! Zur Platzersparnis darf ein Name auf einen früheren Namen im Paket
//! zeigen ("Kompression", zwei Bytes, die mit 0b11 beginnen).

use serde::{Deserialize, Serialize};
use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::time::{Duration, Instant};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DnsRequest {
    pub name: String,
    pub record_type: String,
    /// IP-Adresse des DNS-Servers. Leer = DNS-Server des Systems.
    pub server: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DnsRecord {
    pub name: String,
    pub record_type: String,
    pub ttl: u32,
    pub data: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DnsResponse {
    pub server: String,
    pub query_name: String,
    pub record_type: String,
    pub rcode: u8,
    pub rcode_text: String,
    pub authoritative: bool,
    pub truncated: bool,
    pub elapsed_ms: u32,
    pub answers: Vec<DnsRecord>,
    pub authority: Vec<DnsRecord>,
}

/// Unterstützte Record-Typen: (Name, Nummer laut RFC)
const TYPES: [(&str, u16); 8] = [
    ("A", 1),
    ("NS", 2),
    ("CNAME", 5),
    ("SOA", 6),
    ("PTR", 12),
    ("MX", 15),
    ("TXT", 16),
    ("AAAA", 28),
];

fn type_number(name: &str) -> Option<u16> {
    TYPES.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, t)| *t)
}

fn type_name(t: u16) -> String {
    TYPES
        .iter()
        .find(|(_, n)| *n == t)
        .map(|(name, _)| name.to_string())
        .unwrap_or_else(|| format!("TYP{t}"))
}

fn rcode_text(rcode: u8) -> &'static str {
    match rcode {
        0 => "OK",
        1 => "Formatfehler in der Anfrage",
        2 => "Serverfehler (SERVFAIL)",
        3 => "Domain existiert nicht (NXDOMAIN)",
        4 => "Vom Server nicht unterstützt",
        5 => "Abfrage vom Server verweigert",
        _ => "Unbekannter Fehlercode",
    }
}

// ---------------------------------------------------------------------------
// Öffentliche Funktion
// ---------------------------------------------------------------------------

pub fn query(req: &DnsRequest) -> Result<DnsResponse, String> {
    let qtype = type_number(&req.record_type)
        .ok_or_else(|| format!("Record-Typ \"{}\" wird nicht unterstützt.", req.record_type))?;

    // Bei PTR darf man direkt eine IP eingeben – wir bauen daraus den
    // Reverse-Namen (z. B. 8.8.8.8 → 8.8.8.8.in-addr.arpa).
    let raw = req.name.trim();
    let name = match (qtype, raw.parse::<IpAddr>()) {
        (12, Ok(ip)) => reverse_name(ip),
        _ => validate_name(raw)?,
    };

    let server_ip = match req.server.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => s
            .trim_matches(|c| c == '[' || c == ']')
            .parse::<IpAddr>()
            .map_err(|_| "Der DNS-Server muss eine IP-Adresse sein (z. B. 1.1.1.1).".to_string())?,
        None => system_dns_server()?,
    };
    let server = SocketAddr::new(server_ip, 53);

    let id = random_id();
    let packet = build_query(id, &name, qtype);
    let start = Instant::now();
    let reply = send_udp(server, &packet, id)?;
    let elapsed_ms = start.elapsed().as_millis().min(u32::MAX as u128) as u32;

    let parsed = parse_response(&reply)?;
    Ok(DnsResponse {
        server: server_ip.to_string(),
        query_name: name,
        record_type: type_name(qtype),
        rcode: parsed.rcode,
        rcode_text: rcode_text(parsed.rcode).to_string(),
        authoritative: parsed.authoritative,
        truncated: parsed.truncated,
        elapsed_ms,
        answers: parsed.answers,
        authority: parsed.authority,
    })
}

/// Hostname prüfen: nur ASCII-Buchstaben, Ziffern, '-', '_' und Punkte.
pub fn validate_name(raw: &str) -> Result<String, String> {
    let name = raw.trim().trim_end_matches('.');
    if name.is_empty() {
        return Err("Bitte einen Namen eingeben (z. B. example.com).".into());
    }
    if !name.is_ascii() {
        return Err("Domains mit Umlauten bitte in Punycode eingeben (z. B. xn--mnchen-3ya.de).".into());
    }
    if name.len() > 253 {
        return Err("Der Name ist zu lang (max. 253 Zeichen).".into());
    }
    for label in name.split('.') {
        if label.is_empty() || label.len() > 63 {
            return Err("Ungültiger Name: leere oder zu lange Namensteile.".into());
        }
        if label.starts_with('-') {
            return Err("Ungültiger Name: ein Namensteil darf nicht mit '-' beginnen.".into());
        }
        if !label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return Err("Ungültiger Name. Erlaubt sind Buchstaben (a–z), Ziffern, '-', '_' und Punkte.".into());
        }
    }
    Ok(name.to_ascii_lowercase())
}

/// IP → Name für Reverse-Lookups (PTR).
pub fn reverse_name(ip: IpAddr) -> String {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            format!("{}.{}.{}.{}.in-addr.arpa", o[3], o[2], o[1], o[0])
        }
        IpAddr::V6(v6) => {
            // Jede Hex-Ziffer einzeln, rückwärts: ...b.a.9.8.ip6.arpa
            let mut parts = Vec::with_capacity(34);
            for byte in v6.octets().iter().rev() {
                parts.push(format!("{:x}", byte & 0x0f));
                parts.push(format!("{:x}", byte >> 4));
            }
            parts.push("ip6.arpa".into());
            parts.join(".")
        }
    }
}

/// Erster DNS-Server des Systems.
#[cfg(windows)]
fn system_dns_server() -> Result<IpAddr, String> {
    // Gleiche Quelle wie die Übersicht: verbundene Adapter, IPv4 bevorzugt.
    let adapters = crate::adapters::list_adapters()?;
    let servers: Vec<IpAddr> = adapters
        .iter()
        .filter(|a| a.connected)
        .flat_map(|a| a.dns_servers.iter())
        .filter_map(|s| s.split('%').next()?.parse().ok())
        .collect();
    servers
        .iter()
        .find(|ip| ip.is_ipv4())
        .or(servers.first())
        .copied()
        .ok_or_else(|| "Kein DNS-Server gefunden. Bitte einen Server angeben.".into())
}

#[cfg(not(windows))]
fn system_dns_server() -> Result<IpAddr, String> {
    std::fs::read_to_string("/etc/resolv.conf")
        .ok()
        .and_then(|text| {
            text.lines()
                .filter_map(|l| l.trim().strip_prefix("nameserver"))
                .find_map(|ip| ip.trim().parse().ok())
        })
        .ok_or_else(|| "Kein DNS-Server gefunden. Bitte einen Server angeben.".into())
}

/// Zufällige Transaktions-ID (gegen verwechselte Antworten). Kryptografisch
/// muss sie hier nicht sein – Nanosekunden der Uhrzeit reichen.
fn random_id() -> u16 {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    (nanos ^ (nanos >> 16)) as u16
}

// ---------------------------------------------------------------------------
// Netzwerk
// ---------------------------------------------------------------------------

/// Anfrage senden, auf passende Antwort warten. Zwei Versuche à 2 s.
fn send_udp(server: SocketAddr, packet: &[u8], id: u16) -> Result<Vec<u8>, String> {
    let bind = if server.is_ipv4() { "0.0.0.0:0" } else { "[::]:0" };
    let socket = UdpSocket::bind(bind).map_err(|e| format!("Socket-Fehler: {e}"))?;
    socket
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|e| format!("Socket-Fehler: {e}"))?;

    let mut buf = [0u8; 4096];
    for _attempt in 0..2 {
        socket
            .send_to(packet, server)
            .map_err(|e| format!("Anfrage an {server} konnte nicht gesendet werden: {e}"))?;
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            match socket.recv_from(&mut buf) {
                Ok((n, from)) => {
                    // Nur Antworten vom richtigen Server mit unserer ID akzeptieren.
                    if from.ip() == server.ip() && n >= 12 && u16::from_be_bytes([buf[0], buf[1]]) == id {
                        return Ok(buf[..n].to_vec());
                    }
                }
                Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => break,
                Err(e) => return Err(format!("Fehler beim Empfangen: {e}")),
            }
        }
    }
    Err(format!(
        "Keine Antwort vom DNS-Server {} (Zeitüberschreitung). Ist der Server erreichbar oder blockiert eine Firewall Port 53?",
        server.ip()
    ))
}

// ---------------------------------------------------------------------------
// Paket bauen
// ---------------------------------------------------------------------------

fn build_query(id: u16, name: &str, qtype: u16) -> Vec<u8> {
    let mut p = Vec::with_capacity(64);
    p.extend_from_slice(&id.to_be_bytes());
    p.extend_from_slice(&0x0100u16.to_be_bytes()); // Flags: RD = Rekursion gewünscht
    p.extend_from_slice(&1u16.to_be_bytes()); // 1 Frage
    p.extend_from_slice(&0u16.to_be_bytes()); // 0 Antworten
    p.extend_from_slice(&0u16.to_be_bytes()); // 0 Authority
    p.extend_from_slice(&1u16.to_be_bytes()); // 1 Additional (EDNS, siehe unten)
    for label in name.split('.') {
        p.push(label.len() as u8);
        p.extend_from_slice(label.as_bytes());
    }
    p.push(0); // Ende des Namens
    p.extend_from_slice(&qtype.to_be_bytes());
    p.extend_from_slice(&1u16.to_be_bytes()); // Klasse IN (Internet)

    // EDNS0-Eintrag (OPT): erlaubt Antworten bis 1232 Bytes statt nur 512,
    // damit z. B. lange TXT-Records nicht abgeschnitten werden.
    p.push(0); // Name: Wurzel
    p.extend_from_slice(&41u16.to_be_bytes()); // Typ OPT
    p.extend_from_slice(&1232u16.to_be_bytes()); // UDP-Puffergrösse
    p.extend_from_slice(&0u32.to_be_bytes()); // erweiterte Flags
    p.extend_from_slice(&0u16.to_be_bytes()); // keine Daten
    p
}

// ---------------------------------------------------------------------------
// Antwort parsen
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct Parsed {
    rcode: u8,
    authoritative: bool,
    truncated: bool,
    answers: Vec<DnsRecord>,
    authority: Vec<DnsRecord>,
}

const MALFORMED: &str = "Ungültige DNS-Antwort erhalten.";

fn u16_at(p: &[u8], pos: usize) -> Result<u16, String> {
    p.get(pos..pos + 2).map(|b| u16::from_be_bytes([b[0], b[1]])).ok_or_else(|| MALFORMED.to_string())
}

fn u32_at(p: &[u8], pos: usize) -> Result<u32, String> {
    p.get(pos..pos + 4)
        .map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
        .ok_or_else(|| MALFORMED.to_string())
}

/// Liest einen (evtl. komprimierten) Namen ab `pos`.
/// Rückgabe: (Name, Position direkt nach dem Namen an der Originalstelle).
fn read_name(p: &[u8], mut pos: usize) -> Result<(String, usize), String> {
    let mut labels: Vec<String> = Vec::new();
    let mut end_pos: Option<usize> = None; // Position nach dem ersten Zeiger
    let mut jumps = 0;
    loop {
        let len = *p.get(pos).ok_or(MALFORMED)? as usize;
        if len == 0 {
            pos += 1;
            break;
        }
        if len & 0xC0 == 0xC0 {
            // Zeiger: die unteren 14 Bit sind die Zielposition
            let target = (u16_at(p, pos)? & 0x3FFF) as usize;
            if end_pos.is_none() {
                end_pos = Some(pos + 2);
            }
            jumps += 1;
            if jumps > 64 || target >= p.len() {
                return Err(MALFORMED.into()); // Schutz vor Endlosschleifen
            }
            pos = target;
            continue;
        }
        let label = p.get(pos + 1..pos + 1 + len).ok_or(MALFORMED)?;
        labels.push(String::from_utf8_lossy(label).into_owned());
        pos += 1 + len;
        if labels.len() > 128 {
            return Err(MALFORMED.into());
        }
    }
    let name = if labels.is_empty() { ".".to_string() } else { labels.join(".") };
    Ok((name, end_pos.unwrap_or(pos)))
}

fn parse_response(p: &[u8]) -> Result<Parsed, String> {
    if p.len() < 12 {
        return Err(MALFORMED.into());
    }
    let flags = u16_at(p, 2)?;
    if flags & 0x8000 == 0 {
        return Err(MALFORMED.into()); // QR-Bit fehlt → keine Antwort
    }
    let qd = u16_at(p, 4)? as usize;
    let an = u16_at(p, 6)? as usize;
    let ns = u16_at(p, 8)? as usize;

    let mut pos = 12;
    for _ in 0..qd {
        let (_, next) = read_name(p, pos)?;
        pos = next + 4; // Typ + Klasse überspringen
    }
    let mut answers = Vec::new();
    for _ in 0..an {
        let (rec, next) = read_record(p, pos)?;
        pos = next;
        answers.extend(rec);
    }
    let mut authority = Vec::new();
    for _ in 0..ns {
        let (rec, next) = read_record(p, pos)?;
        pos = next;
        authority.extend(rec);
    }

    Ok(Parsed {
        rcode: (flags & 0x000F) as u8,
        authoritative: flags & 0x0400 != 0,
        truncated: flags & 0x0200 != 0,
        answers,
        authority,
    })
}

/// Einen Resource Record lesen. OPT-Einträge (EDNS) werden übersprungen (None).
fn read_record(p: &[u8], pos: usize) -> Result<(Option<DnsRecord>, usize), String> {
    let (name, mut pos) = read_name(p, pos)?;
    let rtype = u16_at(p, pos)?;
    let ttl = u32_at(p, pos + 4)?;
    let rdlen = u16_at(p, pos + 8)? as usize;
    pos += 10;
    let rdata_end = pos + rdlen;
    if rdata_end > p.len() {
        return Err(MALFORMED.into());
    }
    if rtype == 41 {
        return Ok((None, rdata_end));
    }
    let rdata = &p[pos..rdata_end];

    let data = match rtype {
        1 if rdlen == 4 => std::net::Ipv4Addr::new(rdata[0], rdata[1], rdata[2], rdata[3]).to_string(),
        28 if rdlen == 16 => {
            let mut b = [0u8; 16];
            b.copy_from_slice(rdata);
            std::net::Ipv6Addr::from(b).to_string()
        }
        2 | 5 | 12 => read_name(p, pos)?.0, // NS, CNAME, PTR: ein Name
        15 => {
            // MX: Priorität + Mailserver
            let pref = u16_at(p, pos)?;
            format!("{pref} {}", read_name(p, pos + 2)?.0)
        }
        16 => {
            // TXT: eine oder mehrere Zeichenketten mit Längen-Byte davor
            let mut parts = Vec::new();
            let mut i = 0;
            while i < rdata.len() {
                let l = rdata[i] as usize;
                let s = rdata.get(i + 1..i + 1 + l).ok_or(MALFORMED)?;
                parts.push(String::from_utf8_lossy(s).into_owned());
                i += 1 + l;
            }
            format!("\"{}\"", parts.join(""))
        }
        6 => {
            // SOA: primärer Nameserver, Verantwortlicher, dann 5 Zahlen
            let (mname, next) = read_name(p, pos)?;
            let (rname, next) = read_name(p, next)?;
            let serial = u32_at(p, next)?;
            let minimum = u32_at(p, next + 16)?;
            format!("{mname} {rname} (Serial {serial}, Minimum-TTL {minimum}s)")
        }
        _ => format!("({rdlen} Bytes)"),
    };

    Ok((
        Some(DnsRecord { name, record_type: type_name(rtype), ttl, data }),
        rdata_end,
    ))
}

// ---------------------------------------------------------------------------
// Tests (laufen ohne Netzwerk)
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn namen_pruefen() {
        assert_eq!(validate_name("Example.COM.").unwrap(), "example.com");
        assert!(validate_name("_dmarc.example.com").is_ok());
        for bad in ["", "a..b", "-x.com", "a b.com", "münchen.de", "x;rm", &"a".repeat(64)] {
            assert!(validate_name(bad).is_err(), "{bad:?} sollte abgelehnt werden");
        }
    }

    #[test]
    fn reverse_namen() {
        assert_eq!(reverse_name("8.8.4.4".parse().unwrap()), "4.4.8.8.in-addr.arpa");
        let v6 = reverse_name("2001:db8::1".parse().unwrap());
        assert!(v6.starts_with("1.0.0.0.0.0.0.0"));
        assert!(v6.ends_with("8.b.d.0.1.0.0.2.ip6.arpa"));
    }

    #[test]
    fn anfrage_aufbau() {
        let q = build_query(0xABCD, "example.com", 1);
        assert_eq!(&q[0..2], &[0xAB, 0xCD]);
        assert_eq!(&q[12..25], b"\x07example\x03com\x00");
        assert_eq!(&q[25..29], &[0, 1, 0, 1]); // Typ A, Klasse IN
    }

    /// Echte Antwort-Struktur mit Kompression: example.com → CNAME → A
    #[test]
    fn antwort_mit_kompression() {
        let mut p = vec![
            0xAB, 0xCD, 0x81, 0x80, // ID, Flags: Antwort, RD, RA, rcode 0
            0, 1, 0, 2, 0, 0, 0, 0, // 1 Frage, 2 Antworten
        ];
        p.extend_from_slice(b"\x03www\x07example\x03com\x00\x00\x01\x00\x01"); // Frage ab Offset 12
        // Antwort 1: Name = Zeiger auf 12, CNAME → "example.com" als Zeiger auf Offset 16
        p.extend_from_slice(&[0xC0, 12, 0, 5, 0, 1, 0, 0, 0x0E, 0x10, 0, 2, 0xC0, 16]);
        // Antwort 2: Name = Zeiger auf 16 (example.com), A 93.184.216.34
        p.extend_from_slice(&[0xC0, 16, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 93, 184, 216, 34]);

        let r = parse_response(&p).unwrap();
        assert_eq!(r.rcode, 0);
        assert_eq!(r.answers.len(), 2);
        assert_eq!(
            r.answers[0],
            DnsRecord { name: "www.example.com".into(), record_type: "CNAME".into(), ttl: 3600, data: "example.com".into() }
        );
        assert_eq!(r.answers[1].data, "93.184.216.34");
        assert_eq!(r.answers[1].ttl, 60);
    }

    #[test]
    fn mx_und_txt() {
        let mut p = vec![0, 1, 0x85, 0x80, 0, 1, 0, 2, 0, 0, 0, 0]; // authoritative, 1 Frage
        p.extend_from_slice(b"\x01a\x00\x00\x0f\x00\x01"); // Frage: Name "a" ab Offset 12, Typ MX
        // MX: Name (Zeiger auf "a"), Typ 15, Klasse IN, TTL 256, Länge 4, Priorität 10, Ziel = Zeiger
        p.extend_from_slice(&[0xC0, 12, 0, 15, 0, 1, 0, 0, 1, 0, 0, 4, 0, 10, 0xC0, 12]);
        p.extend_from_slice(&[0xC0, 12, 0, 16, 0, 1, 0, 0, 0, 1, 0, 6, 2, b'h', b'i', 2, b'!', b'?']);
        let r = parse_response(&p).unwrap();
        assert!(r.authoritative);
        assert_eq!(r.answers[0].data, "10 a");
        assert_eq!(r.answers[1].data, "\"hi!?\"");
    }

    #[test]
    fn kaputte_pakete() {
        // Zeiger auf sich selbst → Endlosschleife muss abgefangen werden
        let mut p = vec![0, 1, 0x81, 0x80, 0, 1, 0, 0, 0, 0, 0, 0];
        p.extend_from_slice(&[0xC0, 12]);
        assert!(parse_response(&p).is_err());
        // Abgeschnittenes Paket
        assert!(parse_response(&[0, 1, 0x81]).is_err());
        // RDATA länger als das Paket
        let mut p = vec![0, 1, 0x81, 0x80, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0xFF, 0xFF];
        p.push(1);
        assert!(parse_response(&p).is_err());
    }

    /// Echte Abfrage übers Netz – läuft nur mit `cargo test -- --ignored`,
    /// damit CI-Builds nicht vom Netzwerk abhängen.
    #[test]
    #[ignore]
    fn live_abfrage() {
        for (name, typ) in [("example.com", "A"), ("gmail.com", "MX"), ("example.com", "TXT"), ("1.1.1.1", "PTR")] {
            let r = query(&DnsRequest { name: name.into(), record_type: typ.into(), server: Some("1.1.1.1".into()) })
                .expect("Abfrage fehlgeschlagen");
            println!("{name} {typ}: rcode={} {}ms {:?}", r.rcode, r.elapsed_ms, r.answers);
            assert_eq!(r.rcode, 0);
            assert!(!r.answers.is_empty());
        }
        let r = query(&DnsRequest { name: "gibt-es-nicht-xyz.example".into(), record_type: "A".into(), server: Some("1.1.1.1".into()) }).unwrap();
        assert_eq!(r.rcode, 3);
        println!("NXDOMAIN ok, authority: {:?}", r.authority);
    }

    #[test]
    fn nxdomain() {
        let p = [0, 1, 0x81, 0x83, 0, 0, 0, 0, 0, 0, 0, 0];
        let r = parse_response(&p).unwrap();
        assert_eq!(r.rcode, 3);
        assert_eq!(rcode_text(3), "Domain existiert nicht (NXDOMAIN)");
    }
}
