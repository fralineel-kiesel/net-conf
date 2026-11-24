//! System-Infos: Hostname, Admin-Rechte, Neustart als Administrator.

use tauri::{AppHandle, Manager};

/// Computername (wie bei `hostname` in der Konsole).
#[tauri::command]
pub fn get_hostname() -> String {
    // Unter Windows ist COMPUTERNAME immer gesetzt, unter Linux meist HOSTNAME.
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok().map(|s| s.trim().to_string()))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unbekannt".into())
}

/// Läuft die App mit Administratorrechten (UAC-"erhöht")?
#[tauri::command]
pub fn is_admin() -> bool {
    imp::is_elevated()
}

/// Startet die App mit "Als Administrator ausführen" neu.
/// Bei Erfolg wird die aktuelle Instanz beendet. Bricht der Benutzer den
/// UAC-Dialog ab, kommt eine Fehlermeldung zurück und die App läuft weiter.
///
/// Hinweis: Absichtlich KEIN async-Command – so läuft der Aufruf im
/// Hauptthread, in dem COM bereits initialisiert ist (ShellExecute braucht das).
#[tauri::command]
pub fn restart_as_admin(app: AppHandle) -> Result<(), String> {
    imp::relaunch_elevated()?;
    // Laufende Prozesse (z. B. ping -t) sauber beenden, dann App schliessen.
    app.state::<crate::runner::Runner>().kill_all();
    app.exit(0);
    Ok(())
}

#[cfg(windows)]
mod imp {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    pub fn is_elevated() -> bool {
        // SAFETY: Standard-Abfolge Token öffnen → abfragen → schliessen.
        unsafe {
            let mut token: HANDLE = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return false;
            }
            let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
            let mut ret_len = 0u32;
            let ok = GetTokenInformation(
                token,
                TokenElevation,
                &mut elevation as *mut _ as *mut core::ffi::c_void,
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut ret_len,
            );
            CloseHandle(token);
            ok != 0 && elevation.TokenIsElevated != 0
        }
    }

    /// Rust-String → nullterminierter UTF-16-String für die Windows-API.
    fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
        s.encode_wide().chain(std::iter::once(0)).collect()
    }

    pub fn relaunch_elevated() -> Result<(), String> {
        let exe = std::env::current_exe().map_err(|e| format!("Programmpfad unbekannt: {e}"))?;
        let exe_w = wide(exe.as_os_str());
        let verb = wide(std::ffi::OsStr::new("runas"));
        // SAFETY: Alle Strings sind nullterminiert und leben bis nach dem Aufruf.
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                verb.as_ptr(),
                exe_w.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        };
        // Laut Doku: Rückgabewert > 32 bedeutet Erfolg.
        if result as isize > 32 {
            Ok(())
        } else {
            Err("Der Neustart als Administrator wurde abgebrochen oder ist fehlgeschlagen.".into())
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn is_elevated() -> bool {
        // Einfacher Fallback: Benutzer "root"?
        std::env::var("USER").map(|u| u == "root").unwrap_or(false)
    }

    pub fn relaunch_elevated() -> Result<(), String> {
        Err("Neustart als Administrator gibt es nur unter Windows.".into())
    }
}
