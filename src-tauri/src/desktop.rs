//! Desktop-Komfort: Tray-Icon, Kompaktmodus, „In den Tray minimieren“,
//! Autostart mit Windows und das Öffnen der Release-Seite (Update-Hinweis).
//!
//! * **Tray:** Menü „Öffnen“, „Kompaktmodus“, „Beenden“. Linksklick zeigt das Fenster.
//! * **Kompaktmodus:** EIN Fenster wird umgeschaltet (kein zweites Fenster):
//!   ca. 380×260, immer im Vordergrund. Grösse/Position vorher werden gemerkt
//!   und beim Zurückschalten wiederhergestellt. Das Frontend blendet dazu
//!   Seitenleiste und Konsole aus (Event `compact-changed`).
//! * **Autostart:** Wert „Net-Conf“ unter HKCU\…\Run (nur aktueller Benutzer,
//!   kein Admin). Gestartet wird mit `--tray`, also unsichtbar im Tray.
//!   Achtung: Der Autostart läuft immer OHNE Adminrechte.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, State};

/// Eigenes Repository – für den Update-Check (gleiche Werte in `src/update.ts`).
pub const REPO_OWNER: &str = "fralineel-kiesel";
pub const REPO_NAME: &str = "net-conf";

/// Grösse im Kompaktmodus (logische Pixel, also unabhängig von der Skalierung).
const COMPACT_W: f64 = 380.0;
const COMPACT_H: f64 = 260.0;
/// Mindestgrösse im Normalmodus (wie in tauri.conf.json).
const NORMAL_MIN_W: f64 = 900.0;
const NORMAL_MIN_H: f64 = 600.0;

/// Fenster vor dem Kompaktmodus.
#[derive(Debug, Clone, Copy)]
struct Saved {
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    maximized: bool,
}

/// Tauri-State.
#[derive(Default)]
pub struct Desktop {
    /// Some = Kompaktmodus aktiv (mit der gemerkten Normal-Geometrie)
    compact: Mutex<Option<Saved>>,
    close_to_tray: AtomicBool,
    /// Tray-Icon erfolgreich angelegt? (Sonst darf das Fenster nie verschwinden.)
    tray_ok: AtomicBool,
}

impl Desktop {
    pub fn set_close_to_tray(&self, v: bool) {
        self.close_to_tray.store(v, Ordering::SeqCst);
    }

    /// Soll „Schliessen“ das Fenster nur verstecken?
    pub fn hide_on_close(&self) -> bool {
        self.close_to_tray.load(Ordering::SeqCst) && self.tray_ok.load(Ordering::SeqCst)
    }

    fn is_compact(&self) -> bool {
        self.compact.lock().unwrap_or_else(|e| e.into_inner()).is_some()
    }
}

/// Hauptfenster zeigen und nach vorne holen.
pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Kompaktmodus ein-/ausschalten. Gibt den neuen Zustand zurück.
fn apply_compact(app: &AppHandle, enabled: bool) -> Result<bool, String> {
    let w = app.get_webview_window("main").ok_or("Hauptfenster nicht gefunden.")?;
    let desktop = app.state::<Desktop>();
    let mut compact = desktop.compact.lock().unwrap_or_else(|e| e.into_inner());
    let err = |e: tauri::Error| format!("Fenster konnte nicht umgeschaltet werden: {e}");

    if enabled && compact.is_none() {
        let maximized = w.is_maximized().unwrap_or(false);
        if maximized {
            w.unmaximize().map_err(err)?;
        }
        // Erst NACH dem Verkleinern aus der Maximierung messen – sonst merkt man
        // sich die Bildschirmgrösse statt der normalen Fenstergrösse.
        let saved = Saved {
            position: w.outer_position().map_err(err)?,
            size: w.inner_size().map_err(err)?,
            maximized,
        };
        w.set_min_size(Some(LogicalSize::new(300.0, 200.0))).map_err(err)?;
        w.set_size(LogicalSize::new(COMPACT_W, COMPACT_H)).map_err(err)?;
        w.set_always_on_top(true).map_err(err)?;
        *compact = Some(saved);
    } else if !enabled {
        if let Some(saved) = compact.take() {
            w.set_always_on_top(false).map_err(err)?;
            w.set_min_size(Some(LogicalSize::new(NORMAL_MIN_W, NORMAL_MIN_H))).map_err(err)?;
            w.set_size(saved.size).map_err(err)?;
            w.set_position(saved.position).map_err(err)?;
            if saved.maximized {
                w.maximize().map_err(err)?;
            }
        }
    }
    let now = compact.is_some();
    drop(compact);
    let _ = app.emit("compact-changed", now);
    Ok(now)
}

#[tauri::command]
pub fn set_compact(app: AppHandle, enabled: bool) -> Result<bool, String> {
    apply_compact(&app, enabled)
}

#[tauri::command]
pub fn get_compact(desktop: State<'_, Desktop>) -> bool {
    desktop.is_compact()
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

/// Tray-Icon mit Menü anlegen. Scheitert das, bleibt das Fenster sichtbar.
pub fn create_tray(app: &AppHandle) -> Result<(), String> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let e = |e: tauri::Error| format!("Tray-Icon: {e}");
    let open = MenuItem::with_id(app, "open", "Öffnen", true, None::<&str>).map_err(e)?;
    let compact = MenuItem::with_id(app, "compact", "Kompaktmodus", true, None::<&str>).map_err(e)?;
    let sep = PredefinedMenuItem::separator(app).map_err(e)?;
    let quit = MenuItem::with_id(app, "quit", "Beenden", true, None::<&str>).map_err(e)?;
    let menu = Menu::with_items(app, &[&open, &compact, &sep, &quit]).map_err(e)?;
    let icon = app.default_window_icon().cloned().ok_or("Tray-Icon: kein App-Icon gefunden.")?;

    TrayIconBuilder::with_id("main")
        .icon(icon)
        .tooltip("Net-Conf")
        .menu(&menu)
        .show_menu_on_left_click(false) // Linksklick = Fenster zeigen, Rechtsklick = Menü
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "compact" => {
                let now = app.state::<Desktop>().is_compact();
                show_main(app);
                let _ = apply_compact(app, !now);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        })
        .build(app)
        .map_err(e)?;
    app.state::<Desktop>().tray_ok.store(true, Ordering::SeqCst);
    Ok(())
}

// ---------------------------------------------------------------------------
// Autostart (HKCU\Software\Microsoft\Windows\CurrentVersion\Run)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutostartStatus {
    pub supported: bool,
    pub enabled: bool,
    /// Eintrag vorhanden, zeigt aber auf eine andere .exe (z. B. verschobene portable Version)
    pub other_path: bool,
}

#[cfg(windows)]
mod autostart {
    use super::AutostartStatus;
    use crate::winreg::{delete_value, read_string, set_string, Root};

    const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const RUN_VALUE: &str = "Net-Conf";

    /// Befehlszeile für den Autostart – baut nur das Backend (Pfad dieser .exe).
    fn command_line() -> Result<String, String> {
        let exe = std::env::current_exe().map_err(|e| format!("Programmpfad unbekannt: {e}"))?;
        Ok(format!("\"{}\" --tray", exe.display()))
    }

    pub fn status() -> Result<AutostartStatus, String> {
        let current = read_string(Root::CurrentUser, RUN_KEY, RUN_VALUE)?;
        let ours = command_line()?;
        Ok(AutostartStatus {
            supported: true,
            enabled: current.as_deref() == Some(ours.as_str()),
            other_path: current.is_some_and(|c| !c.eq_ignore_ascii_case(&ours)),
        })
    }

    pub fn set(enabled: bool) -> Result<AutostartStatus, String> {
        if enabled {
            set_string(Root::CurrentUser, RUN_KEY, RUN_VALUE, &command_line()?)?;
        } else {
            delete_value(Root::CurrentUser, RUN_KEY, RUN_VALUE)?;
        }
        status()
    }
}

#[cfg(not(windows))]
mod autostart {
    use super::AutostartStatus;

    pub fn status() -> Result<AutostartStatus, String> {
        Ok(AutostartStatus { supported: false, enabled: false, other_path: false })
    }

    pub fn set(_enabled: bool) -> Result<AutostartStatus, String> {
        Err("Autostart gibt es nur unter Windows.".into())
    }
}

#[tauri::command]
pub async fn autostart_get() -> Result<AutostartStatus, String> {
    autostart::status()
}

#[tauri::command]
pub async fn autostart_set(enabled: bool) -> Result<AutostartStatus, String> {
    autostart::set(enabled)
}

// ---------------------------------------------------------------------------
// Release-Seite öffnen (Update-Hinweis)
// ---------------------------------------------------------------------------

/// Nur Seiten unter https://github.com/<owner>/<repo>/releases… sind erlaubt –
/// mit wenigen, harmlosen Zeichen (kein Query, kein „..“, keine Leerzeichen).
pub fn is_release_url(url: &str) -> bool {
    let prefix = format!("https://github.com/{REPO_OWNER}/{REPO_NAME}/releases");
    let Some(rest) = url.strip_prefix(&prefix) else { return false };
    url.len() <= 200
        && (rest.is_empty() || rest.starts_with('/'))
        && !rest.contains("..")
        && rest.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | '/'))
}

/// Öffnet die Release-Seite im Standardbrowser. Absichtlich KEIN async-Command
/// (ShellExecute im Hauptthread, wie beim Neustart als Admin).
#[tauri::command]
pub fn open_release_page(url: String) -> Result<(), String> {
    if !is_release_url(&url) {
        return Err("Diese Adresse wird aus Sicherheitsgründen nicht geöffnet.".into());
    }
    open_in_browser(&url)
}

#[cfg(windows)]
fn open_in_browser(url: &str) -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let verb = wide("open");
    let target = wide(url);
    // SAFETY: Beide Strings sind nullterminiert und leben bis nach dem Aufruf.
    let r = unsafe {
        ShellExecuteW(std::ptr::null_mut(), verb.as_ptr(), target.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL)
    };
    if r as isize > 32 {
        Ok(())
    } else {
        Err("Der Browser konnte nicht geöffnet werden.".into())
    }
}

#[cfg(not(windows))]
fn open_in_browser(_url: &str) -> Result<(), String> {
    Err("Nur unter Windows verfügbar.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_urls() {
        for ok in [
            "https://github.com/fralineel-kiesel/net-conf/releases",
            "https://github.com/fralineel-kiesel/net-conf/releases/latest",
            "https://github.com/fralineel-kiesel/net-conf/releases/tag/v0.6.0",
            "https://github.com/fralineel-kiesel/net-conf/releases/tag/v1.0.0-beta.2",
        ] {
            assert!(is_release_url(ok), "{ok} sollte erlaubt sein");
        }
        for bad in [
            "http://github.com/fralineel-kiesel/net-conf/releases",
            "https://github.com/fralineel-kiesel/net-conf/releasesX",
            "https://github.com/fralineel-kiesel/net-conf/issues",
            "https://github.com/fralineel-kiesel/net-conf/releases/../../evil",
            "https://github.com/fralineel-kiesel/net-conf/releases?x=1",
            "https://github.com/fralineel-kiesel/net-conf/releases/tag/v1 & calc",
            "https://github.com/fralineel-kiesel/net-conf/releases/\"x",
            "https://github.com.evil.example/fralineel-kiesel/net-conf/releases",
            "file:///C:/Windows/System32/calc.exe",
            "",
        ] {
            assert!(!is_release_url(bad), "{bad} sollte abgelehnt werden");
        }
    }
}
