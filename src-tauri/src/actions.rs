//! Aktionen der Seite "Aktionen" (F2) – die feste Whitelist.
//!
//! Das Frontend schickt nur eine Aktions-ID (z. B. `"releaseRenew"`) und
//! optional einen Adapternamen. Welche Programme mit welchen Argumenten in
//! welcher Reihenfolge laufen, steht AUSSCHLIESSLICH hier.
//!
//! Adapternamen werden nur akzeptiert, wenn sie exakt in der aktuellen
//! Adapterliste von Windows vorkommen (`runner::validate_adapter`).
//!
//! Zum Adapter-Neustart mit netsh: Der Name wird als EIGENES Argument
//! übergeben, in der Positions-Schreibweise
//!     netsh interface set interface "vEthernet (Default Switch)" admin=disabled
//! und NICHT als `name="…"`. Grund: Rust setzt unter Windows Anführungszeichen
//! nur um ein ganzes Argument (wegen der Leerzeichen). Bei `name="…"` lägen
//! die Anführungszeichen mitten im Argument und würden als `\"` maskiert –
//! wie netsh das liest, ist nicht sicher. Die Positionsform ist genau die
//! dokumentierte Form mit einem normal gequoteten Argument. Klammern sind
//! ohne Shell (cmd.exe) ganz normale Zeichen.

use crate::runner::{validate_adapter, Plan, Step};
use serde::Deserialize;

/// Wartezeit zwischen release und renew.
const RELEASE_WAIT_MS: u64 = 2000;
/// Wartezeit zwischen Adapter deaktivieren und aktivieren.
const ADAPTER_WAIT_MS: u64 = 3000;

/// Alle erlaubten Aktionen. Im JSON in camelCase, z. B. `"releaseRenew"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ActionId {
    // IP / DHCP
    Release,
    Renew,
    ReleaseRenew,
    FullRefresh,
    // DNS
    FlushDns,
    DisplayDns,
    RegisterDns,
    DnsRefresh,
    // Cache & Namen
    ArpClear,
    NbtPurge,
    NbtReregister,
    // Adapter
    AdapterRestart,
    // Reparatur (Neustart nötig)
    WinsockReset,
    TcpipReset,
}

/// Wie eine Aktion mit der Adapter-Auswahl umgeht.
#[derive(Debug, PartialEq, Eq)]
enum AdapterUse {
    /// Gilt immer für das ganze System – ein Adapter wird abgelehnt.
    None,
    /// Adapter optional, ohne = alle Adapter.
    Optional,
    /// Nur mit konkretem Adapter.
    Required,
}

impl ActionId {
    fn title(self) -> &'static str {
        match self {
            ActionId::Release => "IP freigeben",
            ActionId::Renew => "IP erneuern",
            ActionId::ReleaseRenew => "Release + Renew",
            ActionId::FullRefresh => "Voller Refresh",
            ActionId::FlushDns => "DNS-Cache leeren",
            ActionId::DisplayDns => "DNS-Cache anzeigen",
            ActionId::RegisterDns => "DNS neu registrieren",
            ActionId::DnsRefresh => "DNS komplett auffrischen",
            ActionId::ArpClear => "ARP-Cache leeren",
            ActionId::NbtPurge => "NetBIOS-Cache neu laden",
            ActionId::NbtReregister => "NetBIOS neu registrieren",
            ActionId::AdapterRestart => "Adapter neu starten",
            ActionId::WinsockReset => "Winsock zurücksetzen",
            ActionId::TcpipReset => "TCP/IP zurücksetzen",
        }
    }

    fn adapter_use(self) -> AdapterUse {
        match self {
            ActionId::Release | ActionId::Renew | ActionId::ReleaseRenew | ActionId::FullRefresh => {
                AdapterUse::Optional
            }
            ActionId::AdapterRestart => AdapterUse::Required,
            _ => AdapterUse::None,
        }
    }
}

/// Prüft die Eingaben und liefert den fertigen Ablauf.
pub fn plan(action: ActionId, adapter: Option<&str>) -> Result<Plan, String> {
    let adapter = match (action.adapter_use(), adapter) {
        (AdapterUse::None, Some(_)) => {
            return Err(format!("„{}“ gilt immer für alle Adapter.", action.title()));
        }
        (AdapterUse::Required, None) => {
            return Err(format!(
                "Für „{}“ bitte einen konkreten Adapter wählen (nicht „Alle Adapter“).",
                action.title()
            ));
        }
        (_, Some(name)) => Some(validate_adapter(name)?),
        (_, None) => None,
    };
    Ok(build_plan(action, adapter.as_deref()))
}

/// Baut den Ablauf. `adapter` ist hier schon geprüft.
fn build_plan(action: ActionId, adapter: Option<&str>) -> Plan {
    let release = || Step::run_with("ipconfig", &["/release"], adapter).disruptive();
    let renew = || Step::run_with("ipconfig", &["/renew"], adapter).restore();
    let flush = || Step::run("ipconfig", &["/flushdns"]);
    let register = || Step::run("ipconfig", &["/registerdns"]);

    let steps = match action {
        ActionId::Release => vec![release()],
        ActionId::Renew => vec![renew()],
        ActionId::ReleaseRenew => vec![release(), Step::wait(RELEASE_WAIT_MS), renew()],
        ActionId::FullRefresh => vec![flush(), release(), Step::wait(RELEASE_WAIT_MS), renew(), register()],
        ActionId::FlushDns => vec![flush()],
        ActionId::DisplayDns => vec![Step::run("ipconfig", &["/displaydns"])],
        ActionId::RegisterDns => vec![register()],
        ActionId::DnsRefresh => vec![flush(), register()],
        // "*" geht ohne Shell 1:1 an arp.exe – keine Platzhalter-Erweiterung.
        ActionId::ArpClear => vec![Step::run("arp", &["-d", "*"])],
        ActionId::NbtPurge => vec![Step::run("nbtstat", &["-R"])],
        ActionId::NbtReregister => vec![Step::run("nbtstat", &["-RR"])],
        ActionId::AdapterRestart => {
            // Positionsform – Begründung oben im Modulkommentar.
            let set = |state: &str| {
                let mut s = Step::run_with("netsh", &["interface", "set", "interface"], adapter);
                if let crate::runner::StepKind::Run { args, .. } = &mut s.kind {
                    args.push(format!("admin={state}"));
                }
                s
            };
            vec![set("disabled").disruptive(), Step::wait(ADAPTER_WAIT_MS), set("enabled").restore()]
        }
        ActionId::WinsockReset => vec![Step::run("netsh", &["winsock", "reset"])],
        ActionId::TcpipReset => vec![Step::run("netsh", &["int", "ip", "reset"])],
    };

    if steps.len() == 1 {
        return Plan::single(steps.into_iter().next().expect("genau ein Schritt"));
    }
    let target = match adapter {
        Some(name) => format!(" – Adapter \"{name}\""),
        None if action.adapter_use() == AdapterUse::Optional => " – alle Adapter".to_string(),
        None => String::new(),
    };
    Plan { title: format!("{}{target}", action.title()), steps }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::StepKind;

    fn labels(p: &Plan) -> Vec<String> {
        p.steps.iter().map(|s| s.label()).collect()
    }

    #[test]
    fn release_renew_ablauf() {
        let p = build_plan(ActionId::ReleaseRenew, Some("WLAN"));
        assert_eq!(p.title, "Release + Renew – Adapter \"WLAN\"");
        assert_eq!(labels(&p), ["ipconfig /release WLAN", "warten (2 s)", "ipconfig /renew WLAN"]);
        assert!(p.steps[0].disruptive && p.steps[2].restore);

        let alle = build_plan(ActionId::ReleaseRenew, None);
        assert_eq!(alle.title, "Release + Renew – alle Adapter");
        assert_eq!(labels(&alle), ["ipconfig /release", "warten (2 s)", "ipconfig /renew"]);
    }

    #[test]
    fn voller_refresh_reihenfolge() {
        let p = build_plan(ActionId::FullRefresh, None);
        assert_eq!(
            labels(&p),
            ["ipconfig /flushdns", "ipconfig /release", "warten (2 s)", "ipconfig /renew", "ipconfig /registerdns"]
        );
    }

    #[test]
    fn adapter_neustart_name_als_eigenes_argument() {
        let p = build_plan(ActionId::AdapterRestart, Some("vEthernet (Default Switch)"));
        let StepKind::Run { program, args } = &p.steps[0].kind else { panic!("Run erwartet") };
        assert_eq!(*program, "netsh");
        assert_eq!(args, &["interface", "set", "interface", "vEthernet (Default Switch)", "admin=disabled"]);
        let StepKind::Run { args, .. } = &p.steps[2].kind else { panic!("Run erwartet") };
        assert_eq!(args.last().map(String::as_str), Some("admin=enabled"));
        assert!(p.steps[0].disruptive && p.steps[2].restore);
        assert_eq!(p.steps[1].kind, StepKind::Wait { ms: ADAPTER_WAIT_MS });
    }

    #[test]
    fn einzelbefehle() {
        assert_eq!(build_plan(ActionId::ArpClear, None).title, "arp -d *");
        assert_eq!(build_plan(ActionId::NbtPurge, None).title, "nbtstat -R");
        assert_eq!(build_plan(ActionId::NbtReregister, None).title, "nbtstat -RR");
        assert_eq!(build_plan(ActionId::WinsockReset, None).title, "netsh winsock reset");
        assert_eq!(build_plan(ActionId::TcpipReset, None).title, "netsh int ip reset");
        assert_eq!(build_plan(ActionId::DisplayDns, None).title, "ipconfig /displaydns");
        assert_eq!(build_plan(ActionId::DnsRefresh, None).steps.len(), 2);
    }

    #[test]
    fn adapter_pruefung() {
        // Unter Linux liefert adapters.rs genau "Mock-Ethernet".
        assert!(plan(ActionId::AdapterRestart, Some("Mock-Ethernet")).is_ok());
        assert!(plan(ActionId::AdapterRestart, None).is_err(), "Adapter ist Pflicht");
        assert!(plan(ActionId::FlushDns, Some("Mock-Ethernet")).is_err(), "kein Adapter erlaubt");
        assert!(plan(ActionId::Renew, Some("Gibt es nicht")).is_err(), "unbekannter Adapter");
        assert!(plan(ActionId::Renew, Some("Mock-Ethernet & calc")).is_err(), "böse Zeichen");
        assert!(plan(ActionId::Renew, None).is_ok());
    }

    #[test]
    fn ids_aus_json() {
        let id: ActionId = serde_json::from_str("\"releaseRenew\"").unwrap();
        assert_eq!(id, ActionId::ReleaseRenew);
        assert!(serde_json::from_str::<ActionId>("\"rmRf\"").is_err());
    }
}
