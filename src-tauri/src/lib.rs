//! Net-Conf – Backend (Tauri v2).
//!
//! Module:
//! * `adapters` – Netzwerkadapter über die Windows-API auslesen
//! * `runner`   – erlaubte Befehle (ipconfig/ping) ausführen und streamen
//! * `system`   – Hostname, Admin-Erkennung, Neustart als Admin

mod adapters;
mod runner;
mod system;

use tauri::{Manager, RunEvent};

/// Liefert alle Netzwerkadapter. `async`, damit der Aufruf nicht den
/// Hauptthread (und damit das Fenster) blockiert.
#[tauri::command]
async fn get_adapters() -> Result<Vec<adapters::AdapterInfo>, String> {
    adapters::list_adapters()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(runner::Runner::default())
        .invoke_handler(tauri::generate_handler![
            get_adapters,
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
