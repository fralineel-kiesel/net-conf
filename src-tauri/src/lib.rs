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
//! * `wifiprofile` – WLAN-Profil: Eingaben prüfen, XML bauen (ohne Windows-API, getestet)
//! * `traffic`  – Live-Traffic aus den Adapter-Zählern (GetIfTable2)
//! * `connections` – TCP/UDP-Verbindungen mit Prozess (wie netstat -ano)
//! * `ipprofile` – IP-Profile (netsh) mit Sicherheitsnetz (30 s „Behalten“)
//! * `winreg`   – kleine Registry-Helfer (nur Windows)
//! * `desktop`  – Tray-Icon, Kompaktmodus, Autostart, Release-Seite öffnen

mod actions;
mod adapters;
mod config;
mod connections;
mod desktop;
mod dns;
mod icmp;
mod ipprofile;
mod lan;
mod monitor;
mod porttest;
mod runner;
mod system;
mod tables;
mod traffic;
mod wifi;
mod wifiprofile;
mod wol;
#[cfg(windows)]
mod winreg;

use tauri::{Manager, RunEvent, WindowEvent};

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
async fn save_config(app: tauri::AppHandle, config: config::Config) -> Result<config::Config, String> {
    let saved = blocking(move || config::save(&config)).await?;
    // „In den Tray minimieren“ gilt sofort
    app.state::<desktop::Desktop>().set_close_to_tray(saved.close_to_tray);
    Ok(saved)
}

/// Magic Packet über den gewählten Adapter senden.
#[tauri::command]
async fn wol_send(mac: String, adapter: String, address: String) -> Result<wol::WolResult, String> {
    blocking(move || wol::wake(&mac, &adapter, &address)).await
}

// ---- Phase 4b: WLAN, Traffic, Verbindungen ---------------------------------

#[tauri::command]
async fn wifi_networks(interface_id: String) -> Result<wifi::WifiScanResult, String> {
    blocking(move || wifi::networks(&interface_id)).await
}

#[tauri::command]
async fn wifi_scan(interface_id: String) -> Result<(), String> {
    blocking(move || wifi::scan(&interface_id)).await
}

#[tauri::command]
async fn wifi_profiles(interface_id: String) -> Result<Vec<wifi::WifiProfile>, String> {
    blocking(move || wifi::profiles(&interface_id)).await
}

#[tauri::command]
async fn wifi_connect_profile(interface_id: String, profile: String) -> Result<String, String> {
    blocking(move || wifi::connect_profile(&interface_id, &profile)).await
}

/// Neues Netz verbinden. Das Passwort steht nur in `request` und wird nach
/// Gebrauch überschrieben – nie loggen, nie in Fehlermeldungen.
#[tauri::command]
async fn wifi_connect(request: wifi::WifiConnectRequest) -> Result<String, String> {
    blocking(move || wifi::connect_new(request)).await
}

#[tauri::command]
async fn wifi_disconnect(interface_id: String) -> Result<(), String> {
    blocking(move || wifi::disconnect(&interface_id)).await
}

#[tauri::command]
async fn wifi_forget(interface_id: String, profile: String) -> Result<(), String> {
    blocking(move || wifi::forget(&interface_id, &profile)).await
}

#[tauri::command]
async fn get_connections() -> Result<Vec<connections::Connection>, String> {
    blocking(connections::list).await
}

/// Reverse-DNS für eine einzelne Adresse (nur auf Klick in "Verbindungen").
#[tauri::command]
async fn reverse_dns(address: String) -> Result<Option<String>, String> {
    blocking(move || connections::reverse(&address)).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(runner::Runner::default())
        .manage(monitor::Monitor::default())
        .manage(lan::LanScanner::default())
        .manage(traffic::Traffic::default())
        .manage(ipprofile::IpGuard::default())
        .manage(desktop::Desktop::default())
        .setup(|app| {
            let handle = app.handle().clone();
            handle.state::<desktop::Desktop>().set_close_to_tray(config::load().config.close_to_tray);
            // Das Fenster startet unsichtbar (tauri.conf.json: "visible": false).
            // Mit --tray (Autostart) bleibt es im Tray – aber nur, wenn das Tray-Icon klappt.
            let tray_ok = match desktop::create_tray(&handle) {
                Ok(()) => true,
                Err(e) => {
                    eprintln!("{e}");
                    false
                }
            };
            let start_in_tray = std::env::args().any(|a| a == "--tray");
            if !(start_in_tray && tray_ok) {
                desktop::show_main(&handle);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Schliessen-Knopf: in den Tray statt beenden (falls eingeschaltet)
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.app_handle().state::<desktop::Desktop>().hide_on_close() {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
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
            wifi_networks,
            wifi_scan,
            wifi_profiles,
            wifi_connect_profile,
            wifi_connect,
            wifi_disconnect,
            wifi_forget,
            traffic::traffic_poll,
            traffic::traffic_reset,
            get_connections,
            reverse_dns,
            ipprofile::ip_profile_preview,
            ipprofile::ip_profile_apply,
            ipprofile::ip_profile_keep,
            ipprofile::ip_profile_revert,
            desktop::set_compact,
            desktop::get_compact,
            desktop::autostart_get,
            desktop::autostart_set,
            desktop::open_release_page,
        ])
        .build(tauri::generate_context!())
        .expect("Net-Conf konnte nicht gestartet werden");

    app.run(|app_handle, event| {
        // Beim Beenden alle Kindprozesse und Hintergrund-Threads stoppen.
        if let RunEvent::Exit = event {
            // Offene IP-Änderung ohne „Behalten“ zuerst zurücknehmen (wartet darauf)
            app_handle.state::<ipprofile::IpGuard>().revert_and_wait();
            app_handle.state::<runner::Runner>().kill_all();
            app_handle.state::<monitor::Monitor>().stop();
            app_handle.state::<lan::LanScanner>().cancel_all();
        }
    });
}
