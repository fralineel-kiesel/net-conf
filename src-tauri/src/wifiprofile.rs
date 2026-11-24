//! WLAN-Profil für "Verbinden": Eingaben prüfen und das Profil-XML bauen.
//!
//! Reine Logik ohne Windows-API → läuft auch unter Linux in `cargo test`.
//! Die Windows-Aufrufe (WlanSetProfile, WlanConnect) stehen in `wifi.rs`.
//!
//! Sicherheitsregeln (siehe CLAUDE.md):
//! * Das Passwort steht NUR im XML, das direkt an WlanSetProfile geht.
//!   Es wird nie geloggt, nie in die Konsole geschrieben, nie in config.json
//!   gespeichert und taucht in keiner Fehlermeldung auf.
//! * Alles, was ins XML kommt, wird escaped (& < > " ') – sonst könnte eine
//!   SSID wie `a</name><x>` das XML verändern.
//! * Strukturen mit Passwort bekommen KEIN `#[derive(Debug)]`, damit es nicht
//!   versehentlich per `{:?}` irgendwo ausgegeben wird.

// Die reine Logik hier nutzt nur der Windows-Teil – unter Linux (cargo test)
// wäre sie sonst "unbenutzt". Massgeblich ist clippy für das Windows-Target.
#![cfg_attr(not(windows), allow(dead_code))]

use serde::{Deserialize, Serialize};

/// Längste SSID laut 802.11: 32 Byte (nicht Zeichen! Umlaute zählen doppelt).
pub const MAX_SSID_BYTES: usize = 32;

/// Welche Art Profil wir anlegen können.
/// (802.1X/Enterprise, WEP und WPA1 bewusst NICHT – dafür über Windows verbinden.)
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Security {
    /// Offenes Netz ohne Verschlüsselung
    Open,
    /// WPA2-Personal mit AES (CCMP)
    Wpa2,
    /// WPA3-Personal (SAE) mit AES
    Wpa3,
}

/// Wie das Passwort im Profil steht.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyType {
    /// Normales Passwort (8–63 Zeichen), Windows berechnet daraus den Schlüssel
    PassPhrase,
    /// Fertiger Schlüssel als 64 Hex-Zeichen (nur WPA2)
    NetworkKey,
}

/// SSID prüfen: nicht leer, max. 32 Byte, keine Steuerzeichen
/// (die könnte XML 1.0 gar nicht darstellen).
pub fn validate_ssid(ssid: &str) -> Result<(), String> {
    if ssid.is_empty() {
        return Err("Bitte eine SSID (WLAN-Namen) eingeben.".into());
    }
    if ssid.len() > MAX_SSID_BYTES {
        return Err(format!(
            "Die SSID ist zu lang ({} Byte). Erlaubt sind höchstens {MAX_SSID_BYTES} Byte (Umlaute zählen doppelt).",
            ssid.len()
        ));
    }
    if ssid.chars().any(char::is_control) {
        return Err("Die SSID enthält Steuerzeichen und kann nicht verwendet werden.".into());
    }
    Ok(())
}

/// Passwort prüfen. WICHTIG: Keine Meldung enthält das Passwort selbst.
pub fn validate_password(security: Security, password: &str) -> Result<Option<KeyType>, String> {
    match security {
        Security::Open => {
            if password.is_empty() {
                Ok(None)
            } else {
                Err("Ein offenes Netz hat kein Passwort – das Feld bitte leer lassen.".into())
            }
        }
        Security::Wpa2 | Security::Wpa3 => {
            // 64 Hex-Zeichen = fertiger Schlüssel (PSK). Gibt es nur bei WPA2;
            // WPA3 (SAE) arbeitet immer mit dem Passwort selbst.
            let is_hex_key = password.len() == 64 && password.bytes().all(|b| b.is_ascii_hexdigit());
            if security == Security::Wpa2 && is_hex_key {
                return Ok(Some(KeyType::NetworkKey));
            }
            // 802.11i: Passphrase aus 8–63 druckbaren ASCII-Zeichen (Leerzeichen bis ~)
            if !password.bytes().all(|b| (0x20..=0x7e).contains(&b)) {
                return Err(
                    "Das WLAN-Passwort darf nur Zeichen ohne Umlaute/Sonderzeichen ausserhalb von ASCII enthalten \
                     (so verlangt es der WLAN-Standard)."
                        .into(),
                );
            }
            let n = password.len(); // nur ASCII → Bytes = Zeichen
            if !(8..=63).contains(&n) {
                return Err(if security == Security::Wpa2 {
                    "Das WLAN-Passwort muss 8–63 Zeichen lang sein (oder genau 64 Hex-Zeichen).".into()
                } else {
                    "Das WLAN-Passwort muss 8–63 Zeichen lang sein.".into()
                });
            }
            Ok(Some(KeyType::PassPhrase))
        }
    }
}

/// Text für XML escapen: & < > " ' werden zu Entitäten.
pub fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

/// SSID als Hex (z. B. "Café" → "436166C3A9"). Windows erkennt das Netz
/// darüber byte-genau, auch bei Sonderzeichen.
pub fn ssid_hex(ssid: &str) -> String {
    ssid.bytes().map(|b| format!("{b:02X}")).collect()
}

/// Profil-XML für Windows bauen (Format "WLANProfile v1", wie `netsh wlan export profile`).
///
/// * Profilname = SSID (so macht es Windows auch)
/// * `connectionMode auto` = "Automatisch verbinden" wie in den Windows-Einstellungen
/// * `nonBroadcast` = verstecktes Netz (sendet seinen Namen nicht)
///
/// Das Ergebnis enthält das Passwort im Klartext (`protected=false`) –
/// Windows verschlüsselt es beim Speichern selbst. Nach Gebrauch sofort
/// verwerfen (siehe `wipe_string`).
pub fn profile_xml(ssid: &str, security: Security, password: &str, hidden: bool) -> Result<String, String> {
    validate_ssid(ssid)?;
    let key_type = validate_password(security, password)?;
    let name = xml_escape(ssid);
    let (auth, enc) = match security {
        Security::Open => ("open", "none"),
        Security::Wpa2 => ("WPA2PSK", "AES"),
        Security::Wpa3 => ("WPA3SAE", "AES"),
    };
    let shared_key = match key_type {
        None => String::new(),
        Some(kt) => {
            let kt = match kt {
                KeyType::PassPhrase => "passPhrase",
                KeyType::NetworkKey => "networkKey",
            };
            format!(
                "\n\t\t\t<sharedKey>\n\t\t\t\t<keyType>{kt}</keyType>\n\t\t\t\t<protected>false</protected>\n\t\t\t\t<keyMaterial>{}</keyMaterial>\n\t\t\t</sharedKey>",
                xml_escape(password)
            )
        }
    };
    Ok(format!(
        r#"<?xml version="1.0"?>
<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">
	<name>{name}</name>
	<SSIDConfig>
		<SSID>
			<hex>{hex}</hex>
			<name>{name}</name>
		</SSID>
		<nonBroadcast>{hidden}</nonBroadcast>
	</SSIDConfig>
	<connectionType>ESS</connectionType>
	<connectionMode>auto</connectionMode>
	<MSM>
		<security>
			<authEncryption>
				<authentication>{auth}</authentication>
				<encryption>{enc}</encryption>
				<useOneX>false</useOneX>
			</authEncryption>{shared_key}
		</security>
	</MSM>
</WLANProfile>"#,
        hex = ssid_hex(ssid),
    ))
}

/// Speicher eines Strings mit Geheimnis überschreiben, bevor er freigegeben wird.
/// "Best effort": Kopien, die z. B. Tauri beim Übertragen gemacht hat, erreichen
/// wir damit nicht – aber die eigenen Puffer liegen nicht mehr lesbar im RAM.
pub fn wipe_string(s: String) {
    let mut bytes = s.into_bytes();
    bytes.fill(0);
    // black_box verhindert, dass der Compiler das Überschreiben "wegoptimiert"
    std::hint::black_box(&bytes);
}

/// Wie `wipe_string`, für UTF-16-Puffer (z. B. das XML für WlanSetProfile).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn wipe_wide(mut v: Vec<u16>) {
    v.fill(0);
    std::hint::black_box(&v);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssid_regeln() {
        assert!(validate_ssid("FRITZ!Box 7590").is_ok());
        assert!(validate_ssid("").is_err());
        assert!(validate_ssid(&"a".repeat(32)).is_ok());
        assert!(validate_ssid(&"a".repeat(33)).is_err());
        // 16 × "ä" = 32 Byte → ok, 17 × = 34 Byte → zu lang
        assert!(validate_ssid(&"ä".repeat(16)).is_ok());
        assert!(validate_ssid(&"ä".repeat(17)).is_err());
        assert!(validate_ssid("a\nb").is_err());
        assert!(validate_ssid("a\u{0}b").is_err());
    }

    #[test]
    fn passwort_regeln() {
        use Security::*;
        assert_eq!(validate_password(Open, ""), Ok(None));
        assert!(validate_password(Open, "geheim123").is_err());
        assert!(validate_password(Wpa2, "1234567").is_err()); // 7 Zeichen
        assert_eq!(validate_password(Wpa2, "12345678"), Ok(Some(KeyType::PassPhrase)));
        assert_eq!(validate_password(Wpa2, &"x".repeat(63)), Ok(Some(KeyType::PassPhrase)));
        assert!(validate_password(Wpa2, &"x".repeat(64)).is_err()); // 64, aber kein Hex
        assert_eq!(validate_password(Wpa2, &"aF09".repeat(16)), Ok(Some(KeyType::NetworkKey)));
        assert!(validate_password(Wpa2, &"a".repeat(65)).is_err());
        assert!(validate_password(Wpa3, &"ab".repeat(32)).is_err()); // Hex-Schlüssel nicht bei WPA3
        assert_eq!(validate_password(Wpa3, "pass word!"), Ok(Some(KeyType::PassPhrase)));
        assert!(validate_password(Wpa2, "Grüezi-Welt").is_err()); // Umlaut
        assert!(validate_password(Wpa2, "tab\there1").is_err()); // Steuerzeichen
    }

    #[test]
    fn fehlermeldungen_enthalten_kein_passwort() {
        for pw in ["kurz", "Grüezi-Welt-123", &"z".repeat(80)] {
            for sec in [Security::Wpa2, Security::Wpa3, Security::Open] {
                if let Err(msg) = profile_xml("Netz", sec, pw, false) {
                    assert!(!msg.contains(pw), "Passwort in Fehlermeldung: {msg}");
                }
            }
        }
    }

    #[test]
    fn escaping() {
        assert_eq!(xml_escape(r#"a&b<c>d"e'f"#), "a&amp;b&lt;c&gt;d&quot;e&apos;f");
        assert_eq!(xml_escape("normal"), "normal");
        assert_eq!(ssid_hex("Café"), "436166C3A9");
    }

    #[test]
    fn xml_wpa2_mit_sonderzeichen() {
        let xml = profile_xml("<Böse & \"SSID\">", Security::Wpa2, "p&ss<w>rd'\"x", false).unwrap();
        assert!(xml.contains("<name>&lt;Böse &amp; &quot;SSID&quot;&gt;</name>"));
        assert!(xml.contains("<keyMaterial>p&amp;ss&lt;w&gt;rd&apos;&quot;x</keyMaterial>"));
        assert!(xml.contains("<authentication>WPA2PSK</authentication>"));
        assert!(xml.contains("<encryption>AES</encryption>"));
        assert!(xml.contains("<keyType>passPhrase</keyType>"));
        assert!(xml.contains("<nonBroadcast>false</nonBroadcast>"));
        // Keine rohen Sonderzeichen aus den Eingaben im XML
        assert!(!xml.contains("<Böse"));
        assert!(!xml.contains("p&ss"));
    }

    #[test]
    fn xml_wpa3_offen_versteckt() {
        let xml = profile_xml("Heim", Security::Wpa3, "geheim-123", true).unwrap();
        assert!(xml.contains("<authentication>WPA3SAE</authentication>"));
        assert!(xml.contains("<nonBroadcast>true</nonBroadcast>"));
        assert!(xml.contains("<hex>4865696D</hex>"));

        let open = profile_xml("Cafe Gast", Security::Open, "", false).unwrap();
        assert!(open.contains("<authentication>open</authentication>"));
        assert!(open.contains("<encryption>none</encryption>"));
        assert!(!open.contains("sharedKey"));

        let hex = profile_xml("X", Security::Wpa2, &"0123456789abcdef".repeat(4), false).unwrap();
        assert!(hex.contains("<keyType>networkKey</keyType>"));
    }
}
