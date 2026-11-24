//! Erlaubte Netzwerk-Befehle ausführen und die Ausgabe live streamen.
//!
//! Sicherheit: Das Frontend schickt KEINE Befehlszeilen, sondern nur ein
//! `NetCommand` aus einer festen Liste. Programm und Argumente baut
//! ausschliesslich das Backend zusammen. Freie Werte (Ping-Ziel,
//! Adaptername) werden streng geprüft. Ausserdem läuft keine Shell
//! (cmd.exe) dazwischen – die Argumente gehen direkt an den Prozess.
//!
//! Events an das Frontend:
//! * `cmd-started`  { runId, commandLine }
//! * `cmd-output`   { runId, stream: "stdout" | "stderr", line }
//! * `cmd-finished` { runId, exitCode, cancelled }

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::{AppHandle, Emitter, State};

/// Die Whitelist: nur diese Befehle sind möglich.
/// Im JSON sieht das z. B. so aus: `{ "kind": "ping", "target": "1.1.1.1", "count": 4 }`
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum NetCommand {
    Release { adapter: Option<String> },
    Renew { adapter: Option<String> },
    FlushDns,
    RegisterDns,
    /// `count: None` = unbegrenzt (`ping -t`), bis abgebrochen wird.
    Ping { target: String, count: Option<u32> },
    /// Routenverfolgung. `resolve = false` → `tracert -d` (keine Namensauflösung, viel schneller).
    Tracert {
        target: String,
        #[serde(default)]
        resolve: bool,
    },
}

/// Ein laufender Prozess.
struct Running {
    child: Mutex<Child>,
    cancelled: AtomicBool,
}

/// Tauri-State: alle aktuell laufenden Prozesse, Schlüssel = runId.
#[derive(Default)]
pub struct Runner {
    running: Mutex<HashMap<u32, Arc<Running>>>,
}

impl Runner {
    fn map(&self) -> MutexGuard<'_, HashMap<u32, Arc<Running>>> {
        // Bei panic=abort gibt es kein "vergiftetes" Mutex, aber sicher ist sicher.
        self.running.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Beendet alle laufenden Prozesse (z. B. beim Schliessen der App,
    /// sonst würde ein `ping -t` unsichtbar weiterlaufen).
    pub fn kill_all(&self) {
        for r in self.map().values() {
            r.cancelled.store(true, Ordering::SeqCst);
            let _ = lock(&r.child).kill();
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StartedEvent {
    run_id: u32,
    command_line: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputEvent {
    run_id: u32,
    stream: &'static str,
    line: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FinishedEvent {
    run_id: u32,
    exit_code: Option<i32>,
    cancelled: bool,
}

/// Startet einen erlaubten Befehl. Die `run_id` vergibt das Frontend, damit
/// es Events schon zuordnen kann, bevor dieser Aufruf zurückkehrt.
#[tauri::command]
pub fn run_command(
    app: AppHandle,
    runner: State<'_, Runner>,
    run_id: u32,
    command: NetCommand,
) -> Result<(), String> {
    let (program, args, command_line) = build_command(&command)?;

    if runner.map().contains_key(&run_id) {
        return Err("Interner Fehler: runId wird bereits verwendet.".into());
    }

    let mut cmd = Command::new(&program);
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Kein schwarzes Konsolenfenster aufblitzen lassen.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Befehl konnte nicht gestartet werden: {e}"))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let running = Arc::new(Running {
        child: Mutex::new(child),
        cancelled: AtomicBool::new(false),
    });
    runner.map().insert(run_id, running.clone());

    let _ = app.emit("cmd-started", StartedEvent { run_id, command_line });

    // Je ein Thread liest stdout und stderr zeilenweise.
    let mut readers = Vec::new();
    if let Some(pipe) = stdout {
        readers.push(spawn_reader(app.clone(), run_id, "stdout", pipe));
    }
    if let Some(pipe) = stderr {
        readers.push(spawn_reader(app.clone(), run_id, "stderr", pipe));
    }

    // Ein dritter Thread wartet auf das Ende und meldet es dem Frontend.
    // Die Reader enden von selbst, sobald der Prozess beendet ist (Pipe zu).
    std::thread::spawn(move || {
        for r in readers {
            let _ = r.join();
        }
        let exit_code = lock(&running.child).wait().ok().and_then(|s| s.code());
        let cancelled = running.cancelled.load(Ordering::SeqCst);
        {
            use tauri::Manager;
            app.state::<Runner>().map().remove(&run_id);
        }
        let _ = app.emit("cmd-finished", FinishedEvent { run_id, exit_code, cancelled });
    });

    Ok(())
}

/// Bricht einen laufenden Befehl ab (Prozess wird beendet).
#[tauri::command]
pub fn cancel_command(runner: State<'_, Runner>, run_id: u32) -> Result<(), String> {
    let running = runner.map().get(&run_id).cloned();
    match running {
        Some(r) => {
            r.cancelled.store(true, Ordering::SeqCst);
            // Fehler ignorieren: Der Prozess kann gerade von selbst beendet sein.
            let _ = lock(&r.child).kill();
            Ok(())
        }
        None => Ok(()), // läuft schon nicht mehr – kein Fehler
    }
}

fn spawn_reader<R: Read + Send + 'static>(
    app: AppHandle,
    run_id: u32,
    stream: &'static str,
    pipe: R,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(pipe);
        let mut buf = Vec::with_capacity(256);
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break, // Ende oder Fehler
                Ok(_) => {
                    // Zeilenende (\r\n oder \n) abschneiden.
                    while matches!(buf.last(), Some(b'\n' | b'\r')) {
                        buf.pop();
                    }
                    let line = decode_console_bytes(&buf);
                    let _ = app.emit("cmd-output", OutputEvent { run_id, stream, line });
                }
            }
        }
    })
}

// ---------------------------------------------------------------------------
// Befehle zusammenbauen
// ---------------------------------------------------------------------------

/// Liefert (Programm, Argumente, Anzeige-Text) für einen erlaubten Befehl.
fn build_command(cmd: &NetCommand) -> Result<(String, Vec<String>, String), String> {
    let (program_name, args): (&str, Vec<String>) = match cmd {
        NetCommand::Release { adapter } => ("ipconfig", with_adapter("/release", adapter)?),
        NetCommand::Renew { adapter } => ("ipconfig", with_adapter("/renew", adapter)?),
        NetCommand::FlushDns => ("ipconfig", vec!["/flushdns".into()]),
        NetCommand::RegisterDns => ("ipconfig", vec!["/registerdns".into()]),
        NetCommand::Ping { target, count } => {
            let target = validate_target(target)?;
            ("ping", ping_args(&target, *count)?)
        }
        NetCommand::Tracert { target, resolve } => {
            let target = validate_target(target)?;
            ("tracert", tracert_args(&target, *resolve))
        }
    };

    // Anzeige wie in der Konsole, z. B.: ipconfig /renew "WLAN"
    let shown_args: Vec<String> = args
        .iter()
        .map(|a| if a.contains(' ') { format!("\"{a}\"") } else { a.clone() })
        .collect();
    let command_line = format!("{program_name} {}", shown_args.join(" "));

    Ok((program_path(program_name)?, args, command_line))
}

fn with_adapter(option: &str, adapter: &Option<String>) -> Result<Vec<String>, String> {
    let mut args = vec![option.to_string()];
    if let Some(name) = adapter {
        args.push(validate_adapter(name)?);
    }
    Ok(args)
}

/// Volle Pfade zu System32 verwenden, damit nicht versehentlich eine
/// gleichnamige Datei aus einem anderen Ordner gestartet wird.
#[cfg(windows)]
fn program_path(name: &str) -> Result<String, String> {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    Ok(format!(r"{root}\System32\{name}.exe"))
}

/// Ausserhalb von Windows gibt es kein ipconfig – nur ping funktioniert.
#[cfg(not(windows))]
fn program_path(name: &str) -> Result<String, String> {
    match name {
        "ping" => Ok("ping".into()),
        _ => Err("Dieser Befehl ist nur unter Windows verfügbar.".into()),
    }
}

#[cfg(windows)]
fn ping_args(target: &str, count: Option<u32>) -> Result<Vec<String>, String> {
    let mut args = match count {
        Some(n) => vec!["-n".to_string(), validate_count(n)?.to_string()],
        None => vec!["-t".to_string()],
    };
    args.push(target.to_string());
    Ok(args)
}

#[cfg(not(windows))]
fn ping_args(target: &str, count: Option<u32>) -> Result<Vec<String>, String> {
    let mut args = match count {
        Some(n) => vec!["-c".to_string(), validate_count(n)?.to_string()],
        None => vec![],
    };
    args.push(target.to_string());
    Ok(args)
}

/// tracert: max. 30 Hops, 1 s Wartezeit pro Antwort (Standard wären 4 s).
fn tracert_args(target: &str, resolve: bool) -> Vec<String> {
    let mut args: Vec<String> = vec!["-h".into(), "30".into(), "-w".into(), "1000".into()];
    if !resolve {
        args.push("-d".into());
    }
    args.push(target.to_string());
    args
}

fn validate_count(n: u32) -> Result<u32, String> {
    if (1..=100).contains(&n) {
        Ok(n)
    } else {
        Err("Die Anzahl muss zwischen 1 und 100 liegen.".into())
    }
}

/// Ping-Ziel prüfen: Hostname, IPv4 oder IPv6.
/// Erlaubt: a–z, A–Z, 0–9, Punkt, Bindestrich, Doppelpunkt (für IPv6).
/// Darf NICHT mit "-" beginnen, sonst würde ping es als Option lesen.
pub fn validate_target(raw: &str) -> Result<String, String> {
    let t = raw.trim();
    if t.is_empty() {
        return Err("Bitte ein Ziel eingeben (IP-Adresse oder Hostname).".into());
    }
    if t.len() > 253 {
        return Err("Das Ziel ist zu lang.".into());
    }
    if t.starts_with('-') || t.starts_with('.') {
        return Err("Das Ziel darf nicht mit '-' oder '.' beginnen.".into());
    }
    if !t.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':')) {
        return Err(
            "Ungültiges Ziel. Erlaubt sind nur Buchstaben (a–z), Ziffern, Punkt, Bindestrich und Doppelpunkt."
                .into(),
        );
    }
    Ok(t.to_string())
}

/// Adaptername prüfen (z. B. "WLAN", "Ethernet 2", "vEthernet (WSL)").
/// Erlaubt: Buchstaben inkl. Umlaute, Ziffern, Leerzeichen, - _ . ( ) #
/// Zusätzlich muss es einen Adapter mit genau diesem Namen geben.
pub fn validate_adapter(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    if name.is_empty() || name.chars().count() > 128 {
        return Err("Ungültiger Adaptername.".into());
    }
    if name.starts_with('-') || name.starts_with('/') {
        return Err("Ungültiger Adaptername.".into());
    }
    if !name
        .chars()
        .all(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.' | '(' | ')' | '#'))
    {
        return Err(format!(
            "Der Adaptername \"{name}\" enthält Zeichen, die Net-Conf aus Sicherheitsgründen nicht erlaubt. \
             Bitte \"Alle Adapter\" wählen oder den Adapter in Windows umbenennen."
        ));
    }
    let exists = crate::adapters::list_adapters()
        .map(|list| list.iter().any(|a| a.name == name))
        .unwrap_or(false);
    if !exists {
        return Err(format!("Adapter \"{name}\" wurde nicht gefunden."));
    }
    Ok(name.to_string())
}

// ---------------------------------------------------------------------------
// Ausgabe dekodieren
// ---------------------------------------------------------------------------

/// Windows-Konsolenprogramme (ipconfig, ping) schreiben in der OEM-Codepage
/// (auf deutschem Windows meist cp850), nicht in UTF-8. Ohne Umwandlung
/// würden Umlaute kaputt aussehen ("Zeit├╝berschreitung").
///
/// `MultiByteToWideChar(CP_OEMCP, …)` nutzt genau die Codepage, die
/// `GetOEMCP()` liefert – egal ob 850, 437 oder (Beta-Option) 65001/UTF-8.
#[cfg(windows)]
fn decode_console_bytes(bytes: &[u8]) -> String {
    use windows_sys::Win32::Globalization::{MultiByteToWideChar, CP_OEMCP};

    if bytes.is_empty() {
        return String::new();
    }
    // Reines ASCII ist in jeder Codepage gleich – Abkürzung.
    if bytes.is_ascii() {
        return String::from_utf8_lossy(bytes).into_owned();
    }
    let len = bytes.len().min(i32::MAX as usize) as i32;
    // SAFETY: Erster Aufruf mit Null-Puffer fragt nur die nötige Länge ab,
    // der zweite schreibt höchstens `needed` UTF-16-Zeichen in `wide`.
    unsafe {
        let needed = MultiByteToWideChar(CP_OEMCP, 0, bytes.as_ptr(), len, std::ptr::null_mut(), 0);
        if needed <= 0 {
            return String::from_utf8_lossy(bytes).into_owned();
        }
        let mut wide = vec![0u16; needed as usize];
        let written = MultiByteToWideChar(CP_OEMCP, 0, bytes.as_ptr(), len, wide.as_mut_ptr(), needed);
        if written <= 0 {
            return String::from_utf8_lossy(bytes).into_owned();
        }
        String::from_utf16_lossy(&wide[..written as usize])
    }
}

#[cfg(not(windows))]
fn decode_console_bytes(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

// ---------------------------------------------------------------------------
// Tests (laufen auch unter Linux: `cargo test`)
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gueltige_ziele() {
        for t in ["1.1.1.1", "google.com", "my-host", "2606:4700:4700::1111", " 8.8.8.8 "] {
            assert!(validate_target(t).is_ok(), "{t} sollte gültig sein");
        }
    }

    #[test]
    fn boese_ziele() {
        for t in [
            "",
            "-t",
            "-n 1000 1.1.1.1",
            "1.1.1.1 & calc",
            "1.1.1.1;whoami",
            "a|b",
            "\"x\"",
            "host/path",
            "$(id)",
            "..",
            "%TEMP%",
        ] {
            assert!(validate_target(t).is_err(), "{t:?} sollte abgelehnt werden");
        }
    }

    #[test]
    fn adapterzeichen() {
        // Ungültige Zeichen werden schon vor der Existenzprüfung abgelehnt.
        for n in ["", "/all", "-x", "WLAN & calc", "a\"b", "x;y", "*", "a|b"] {
            assert!(validate_adapter(n).is_err(), "{n:?} sollte abgelehnt werden");
        }
    }

    #[test]
    fn tracert_argumente() {
        assert_eq!(tracert_args("1.1.1.1", false), ["-h", "30", "-w", "1000", "-d", "1.1.1.1"]);
        assert_eq!(tracert_args("example.com", true), ["-h", "30", "-w", "1000", "example.com"]);
        // Das Ziel wird genauso streng geprüft wie bei ping
        let cmd = NetCommand::Tracert { target: "-h 99 x".into(), resolve: false };
        assert!(build_command(&cmd).is_err());
    }

    #[test]
    fn anzahl() {
        assert!(validate_count(0).is_err());
        assert!(validate_count(4).is_ok());
        assert!(validate_count(101).is_err());
    }
}
