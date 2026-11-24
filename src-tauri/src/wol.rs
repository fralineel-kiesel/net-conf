//! Wake-on-LAN: "Magic Packet" per UDP-Broadcast senden.
//!
//! Aufbau des Magic Packets (102 Bytes):
//!   6 × 0xFF  gefolgt von  16 × die MAC-Adresse des Zielgeräts
//! Die Netzwerkkarte des schlafenden Geräts sucht genau dieses Muster.
//!
//! Gesendet wird an UDP-Port 9 ("discard"), zweimal:
//! * an die Broadcast-Adresse des Subnetzes (z. B. 192.168.1.255) und
//! * an 255.255.255.255 (lokaler Broadcast).
//!
//! Der Socket wird an die IPv4-Adresse des gewählten Adapters gebunden,
//! damit Windows das Paket über genau diesen Adapter verschickt.
//!
//! Reine Standardbibliothek, kein unsafe.

use serde::Serialize;
use std::net::{Ipv4Addr, SocketAddrV4, UdpSocket};

pub const WOL_PORT: u16 = 9;

/// MAC-Adresse prüfen und in 6 Bytes umwandeln.
/// Erlaubt: "AA-BB-CC-DD-EE-FF", "aa:bb:cc:dd:ee:ff", "AABBCCDDEEFF"
/// (auch gemischt gross/klein, mit Leerzeichen am Rand).
pub fn parse_mac(raw: &str) -> Result<[u8; 6], String> {
    let s = raw.trim();
    let err = || format!("„{s}“ ist keine gültige MAC-Adresse. Beispiel: AA-BB-CC-DD-EE-FF");
    let hex: String = if s.len() == 12 {
        s.to_string()
    } else if s.len() == 17 {
        // Trenner an Position 2, 5, 8, 11, 14 – alle gleich ("-" oder ":")
        let sep = s.as_bytes()[2];
        if sep != b'-' && sep != b':' {
            return Err(err());
        }
        let parts: Vec<&str> = s.split(sep as char).collect();
        if parts.len() != 6 || parts.iter().any(|p| p.len() != 2) {
            return Err(err());
        }
        parts.concat()
    } else {
        return Err(err());
    };
    if !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(err());
    }
    let mut mac = [0u8; 6];
    for (i, byte) in mac.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).map_err(|_| err())?;
    }
    if mac == [0; 6] || mac == [0xFF; 6] {
        return Err("Diese MAC-Adresse kann kein Gerät haben (alles 0 bzw. alles FF).".into());
    }
    if mac[0] & 0x01 != 0 {
        return Err("Das ist eine Multicast-MAC-Adresse – kein einzelnes Gerät.".into());
    }
    Ok(mac)
}

/// 6 Bytes → "AA-BB-CC-DD-EE-FF" (Windows-Schreibweise, wie in der Übersicht).
pub fn format_mac(mac: &[u8; 6]) -> String {
    mac.iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join("-")
}

/// Das Magic Packet: 6 × FF, dann 16 × MAC.
pub fn magic_packet(mac: &[u8; 6]) -> [u8; 102] {
    let mut p = [0xFFu8; 102];
    for i in 0..16 {
        p[6 + i * 6..12 + i * 6].copy_from_slice(mac);
    }
    p
}

/// Broadcast-Adresse eines Subnetzes, z. B. 192.168.1.42/24 → 192.168.1.255.
pub fn subnet_broadcast(ip: Ipv4Addr, prefix: u8) -> Ipv4Addr {
    let p = prefix.min(32) as u32;
    let mask: u32 = if p == 0 { 0 } else { u32::MAX << (32 - p) };
    Ipv4Addr::from(u32::from(ip) | !mask)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WolResult {
    pub mac: String,
    /// Ziele, an die das Paket ging, z. B. ["192.168.1.255:9", "255.255.255.255:9"]
    pub sent_to: Vec<String>,
}

/// Magic Packet über den Adapter `adapter` (Name, muss exakt existieren)
/// mit der eigenen Adresse `address` senden.
pub fn wake(mac_raw: &str, adapter: &str, address: &str) -> Result<WolResult, String> {
    let mac = parse_mac(mac_raw)?;
    let (src, prefix) = crate::lan::adapter_ipv4(adapter, address)?;
    let packet = magic_packet(&mac);

    let socket = UdpSocket::bind(SocketAddrV4::new(src, 0))
        .map_err(|e| format!("Socket konnte nicht geöffnet werden: {e}"))?;
    socket.set_broadcast(true).map_err(|e| format!("Broadcast nicht erlaubt: {e}"))?;

    let mut targets = vec![subnet_broadcast(src, prefix)];
    if targets[0] != Ipv4Addr::BROADCAST {
        targets.push(Ipv4Addr::BROADCAST);
    }
    let mut sent_to = Vec::new();
    let mut last_err = None;
    for t in targets {
        match socket.send_to(&packet, SocketAddrV4::new(t, WOL_PORT)) {
            Ok(_) => sent_to.push(format!("{t}:{WOL_PORT}")),
            Err(e) => last_err = Some(format!("Senden an {t} fehlgeschlagen: {e}")),
        }
    }
    if sent_to.is_empty() {
        return Err(last_err.unwrap_or_else(|| "Magic Packet konnte nicht gesendet werden.".into()));
    }
    Ok(WolResult { mac: format_mac(&mac), sent_to })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mac_formate() {
        let want = [0xAA, 0xBB, 0xCC, 0x01, 0x02, 0x03];
        for s in ["AA-BB-CC-01-02-03", "aa:bb:cc:01:02:03", "AABBCC010203", " aabbcc010203 ", "Aa-bB-cC-01-02-03"] {
            assert_eq!(parse_mac(s).unwrap(), want, "{s:?}");
        }
        assert_eq!(format_mac(&want), "AA-BB-CC-01-02-03");
    }

    #[test]
    fn mac_ungueltig() {
        for s in [
            "",
            "AA-BB-CC-01-02",
            "AA-BB-CC-01-02-03-04",
            "AA:BB-CC:01-02:03", // gemischte Trenner
            "GG-BB-CC-01-02-03",
            "AABBCC01020",
            "AA BB CC 01 02 03",
            "00-00-00-00-00-00",
            "FF-FF-FF-FF-FF-FF",
            "01-00-5E-00-00-16", // Multicast
            "AA-BB-CC-01-02-0;",
            "+A-BB-CC-01-02-03",
        ] {
            assert!(parse_mac(s).is_err(), "{s:?} sollte abgelehnt werden");
        }
    }

    #[test]
    fn magic_packet_aufbau() {
        let mac = [1, 2, 3, 4, 5, 6];
        let p = magic_packet(&mac);
        assert_eq!(p.len(), 102);
        assert_eq!(&p[..6], &[0xFF; 6]);
        for i in 0..16 {
            assert_eq!(&p[6 + i * 6..12 + i * 6], &mac);
        }
    }

    #[test]
    fn broadcast() {
        let ip = Ipv4Addr::new(192, 168, 1, 42);
        assert_eq!(subnet_broadcast(ip, 24), Ipv4Addr::new(192, 168, 1, 255));
        assert_eq!(subnet_broadcast(ip, 22), Ipv4Addr::new(192, 168, 3, 255));
        assert_eq!(subnet_broadcast(Ipv4Addr::new(10, 1, 2, 3), 8), Ipv4Addr::new(10, 255, 255, 255));
    }
}
