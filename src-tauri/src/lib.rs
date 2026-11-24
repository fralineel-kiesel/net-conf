//! Net-Conf – Backend (Tauri v2).
//!
//! Module:
//! * `adapters` – Netzwerkadapter über die Windows-API auslesen
//! * `runner`   – Abläufe (Befehle aus der Whitelist) ausführen und streamen
//! * `actions`  – die festen Aktionen der Seite "Aktionen" (Aktions-IDs)
//! * `system`   – Hostname, Admin-Erkennung, Neustart als Admin
//! * `dns`      – DNS-Abfragen (eigener kleiner Client, wie nslookup)
//! * `porttest` – TCP-Port-Test
//! * `tables`   – ARP- und Routing-Tabelle
//! * `wifi`     – WLAN-Infos (SSID, Signal, Kanal …)
//! * `icmp`     – native Pings (IcmpSendEcho), ohne ping.exe und ohne Adminrechte
//! * `config`   – config.json in %APPDATA%\Net-Conf (Monitor-Ziele, WoL-Geräte)
//! * `monitor`  – Ping-Monitor im Hintergrund (läuft weiter beim Seitenwechsel)
//! * `lan`      – LAN-Scanner (SendARP, nur eigenes privates Subnetz)
//! * `wol`      – Wake-on-LAN (Magic Packet)

mod actions;
mod adapters;
mod config;
mod dns;
mod icmp;
mod lan;
mod monitor;
mod porttest;
mod runner;
mod system;
mod tables;
mod wifi;
mod wol;

use tauri::{Manager, RunEvent};

/// Liefert alle Netzwerkadapter. `async`, damit der Aufruf nicht den
/// Hauptthread (und damit das Fenster) blockiert.
#[tauri::command]
async fn get_adapters() -> Result<Vec<adapters::AdapterInfo>, String> {
    adapters::list_adapters()
}

/// Führt eine blockierende Funktion in einem eigenen Thread-Pool aus, damit
/// lange Wartezeiten (z. B. DNS-Timeout) weder das Fenster noch andere
/// Befehle aufhalten.
async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("Interner Fehler: {e}"))?
}

#[tauri::command]
async fn dns_query(request: dns::DnsRequest) -> Result<dns::DnsResponse, String> {
    blocking(move || dns::query(&request)).await
}

#[tauri::command]
async fn port_test(request: porttest::PortTestRequest) -> Result<porttest::PortTestResponse, String> {
    blocking(move || porttest::run(&request)).await
}

#[tauri::command]
async fn get_arp_table() -> Result<Vec<tables::NeighborEntry>, String> {
    blocking(tables::arp_table).await
}

#[tauri::command]
async fn get_route_table() -> Result<Vec<tables::RouteEntry>, String> {
    blocking(tables::route_table).await
}

#[tauri::command]
async fn get_wifi() -> Result<Vec<wifi::WifiInfo>, String> {
    blocking(wifi::wifi_interfaces).await
}

// ---- Phase 4a: Diagnose --------------------------------------------------

/// Ein nativer Ping (ICMP) – z. B. für den Health-Check und den WoL-Check.
#[tauri::command]
async fn icmp_ping(target: String, timeout_ms: u32) -> Result<icmp::PingResult, String> {
    blocking(move || icmp::ping_target(&target, timeout_ms)).await
}

/// Namensauflösung über den System-Resolver (wie der Browser), mit Zeitlimit.
#[tauri::command]
async fn resolve_name(name: String, timeout_ms: u32) -> Result<icmp::ResolveResult, String> {
    blocking(move || icmp::resolve_system(&name, timeout_ms)).await
}

#[tauri::command]
async fn load_config() -> Result<config::LoadResult, String> {
    blocking(|| Ok(config::load())).await
}

#[tauri::command]
async fn save_config(config: config::Config) -> Result<config::Config, String> {
    blocking(move || config::save(&config)).await
}

/// Magic Packet über den gewählten Adapter senden.
#[tauri::command]
async fn wol_send(mac: String, adapter: String, address: String) -> Result<wol::WolResult, String> {
    blocking(move || wol::wake(&mac, &adapter, &address)).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(runner::Runner::default())
        .manage(monitor::Monitor::default())
        .manage(lan::LanScanner::default())
        .invoke_handler(tauri::generate_handler![
            get_adapters,
            dns_query,
            port_test,
            get_arp_table,
            get_route_table,
            get_wifi,
            runner::run_command,
            runner::run_action,
            runner::cancel_command,
            system::get_hostname,
            system::is_admin,
            system::restart_as_admin,
            icmp_ping,
            resolve_name,
            load_config,
            save_config,
            wol_send,
            monitor::monitor_set,
            monitor::monitor_start,
            monitor::monitor_stop,
            monitor::monitor_status,
            monitor::monitor_clear_log,
            lan::lan_scan_start,
            lan::lan_scan_cancel,
        ])
        .build(tauri::generate_context!())
        .expect("Net-Conf konnte nicht gestartet werden");

    app.run(|app_handle, event| {
        // Beim Beenden alle Kindprozesse und Hintergrund-Threads stoppen.
        if let RunEvent::Exit = event {
            app_handle.state::<runner::Runner>().kill_all();
            app_handle.state::<monitor::Monitor>().stop();
            app_handle.state::<lan::LanScanner>().cancel_all();
        }
    });
}
