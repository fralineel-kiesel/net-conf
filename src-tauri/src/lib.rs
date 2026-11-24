//! Net-Conf – Backend (Tauri v2).
//!
//! Module:
//! * `adapters` – Netzwerkadapter über die Windows-API auslesen
//! * `runner`   – erlaubte Befehle (ipconfig/ping) ausführen und streamen
//! * `system`   – Hostname, Admin-Erkennung, Neustart als Admin
//! * `dns`      – DNS-Abfragen (eigener kleiner Client, wie nslookup)
//! * `porttest` – TCP-Port-Test
//! * `tables`   – ARP- und Routing-Tabelle
//! * `wifi`     – WLAN-Infos (SSID, Signal, Kanal …)

mod adapters;
mod dns;
mod porttest;
mod runner;
mod system;
mod tables;
mod wifi;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(runner::Runner::default())
        .invoke_handler(tauri::generate_handler![
            get_adapters,
            dns_query,
            port_test,
            get_arp_table,
            get_route_table,
            get_wifi,
            runner::run_command,
            runner::cancel_command,
            system::get_hostname,
            system::is_admin,
            system::restart_as_admin,
        ])
        .build(tauri::generate_context!())
        .expect("Net-Conf konnte nicht gestartet werden");

    app.run(|app_handle, event| {
        // Beim Beenden alle Kindprozesse stoppen, damit nichts weiterläuft.
        if let RunEvent::Exit = event {
            app_handle.state::<runner::Runner>().kill_all();
        }
    });
}
