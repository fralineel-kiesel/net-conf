//! Erlaubte Netzwerk-Befehle ausführen und die Ausgabe live streamen.
//!
//! Sicherheit: Das Frontend schickt KEINE Befehlszeilen, sondern nur
//! * ein `NetCommand` (Ping, Traceroute) mit streng geprüften Werten oder
//! * eine Aktions-ID (siehe `actions.rs`), z. B. `releaseRenew`.
//!
//! Programm und Argumente baut ausschliesslich das Backend zusammen. Es läuft
//! keine Shell (cmd.exe) dazwischen – die Argumente gehen als Liste direkt an
//! den Prozess.
//!
//! Intern ist alles ein **Ablauf** (`Plan`) aus Schritten: Prozess starten
//! oder warten. Ein Ping ist ein Ablauf mit genau einem Schritt,
//! "Release + Renew" einer mit drei (release → warten → renew).
//!
//! Events an das Frontend:
//! * `cmd-started`  { runId, commandLine }
//! * `cmd-step`     { runId, index, total, label, recovery }   (nur bei mehreren Schritten)
//! * `cmd-output`   { runId, stream: "stdout" | "stderr", line }
//! * `cmd-finished` { runId, exitCode, cancelled, failedStep, error }

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

/// Erlaubte Werte für `ping -n`. Alles andere lehnt das Backend ab.
/// (`count: None` = unbegrenzt, also `ping -t`.)
pub const PING_COUNTS: [u32; 5] = [2, 4, 8, 16, 32];

/// Die Whitelist für Werkzeuge mit freier Eingabe (Ziel).
/// Im JSON sieht das z. B. so aus: `{ "kind": "ping", "target": "1.1.1.1", "count": 4 }`
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum NetCommand {
    /// `count: None` = unbegrenzt (`ping -t`), bis abgebrochen wird.
    Ping { target: String, count: Option<u32> },
    /// Routenverfolgung. `resolve = false` → `tracert -d` (keine Namensauflösung, viel schneller).
    Tracert {
        target: String,
        #[serde(default)]
        resolve: bool,
    },
}

// ---------------------------------------------------------------------------
// Abläufe und Schritte
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StepKind {
    /// Programm aus System32 (Name ohne ".exe") mit festen Argumenten.
    Run { program: &'static str, args: Vec<String> },
    /// Warten, z. B. zwischen release und renew.
    Wait { ms: u64 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Step {
    pub kind: StepKind,
    /// Trennt die Verbindung (z. B. `ipconfig /release`, Adapter deaktivieren).
    pub disruptive: bool,
    /// Stellt die Verbindung wieder her (z. B. `ipconfig /renew`, Adapter
    /// aktivieren). Läuft AUCH nach einem Fehler oder Abbruch – aber nur, wenn
    /// vorher ein `disruptive`-Schritt lief. Sonst stünde man ohne Netz da.
    pub restore: bool,
    /// Läuft auch dann, wenn ein früherer Schritt gescheitert ist (nicht aber
    /// nach einem Abbruch). Für Wiederherstellungs-Abläufe, bei denen jeder
    /// Schritt für sich zählt (IP-Profile: Adresse UND DNS zurücksetzen).
    pub always: bool,
}

impl Step {
    pub fn run(program: &'static str, args: &[&str]) -> Step {
        Step {
            kind: StepKind::Run { program, args: args.iter().map(|a| a.to_string()).collect() },
            disruptive: false,
            restore: false,
            always: false,
        }
    }

    /// Wie `run`, aber mit einem zusätzlichen Argument (z. B. Adaptername).
    /// Der Name ist ein EIGENES Argument – er wird nie in einen String eingebaut.
    pub fn run_with(program: &'static str, args: &[&str], extra: Option<&str>) -> Step {
        let mut step = Step::run(program, args);
        if let (StepKind::Run { args, .. }, Some(x)) = (&mut step.kind, extra) {
            args.push(x.to_string());
        }
        step
    }

    pub fn wait(ms: u64) -> Step {
        Step { kind: StepKind::Wait { ms }, disruptive: false, restore: false, always: false }
    }

    /// Programm mit fertiger Argumentliste (jedes Element ein eigenes Argument).
    pub fn run_args(program: &'static str, args: Vec<String>) -> Step {
        Step { kind: StepKind::Run { program, args }, disruptive: false, restore: false, always: false }
    }

    pub fn disruptive(mut self) -> Step {
        self.disruptive = true;
        self
    }

    pub fn restore(mut self) -> Step {
        self.restore = true;
        self
    }

    pub fn always(mut self) -> Step {
        self.always = true;
        self
    }

    /// Anzeige für Konsole und Schrittmarker, z. B. `ipconfig /renew "WLAN"`.
    pub fn label(&self) -> String {
        match &self.kind {
            StepKind::Run { program, args } => display_line(program, args),
            StepKind::Wait { ms } => format!("warten ({} s)", ms.div_ceil(1000)),
        }
    }
}

/// Ein Ablauf: Titel (erste Konsolenzeile) und Schritte.
#[derive(Debug, Clone)]
pub struct Plan {
    pub title: String,
    pub steps: Vec<Step>,
}

impl Plan {
    /// Ablauf mit genau einem Schritt – der Titel ist die Befehlszeile.
    pub fn single(step: Step) -> Plan {
        Plan { title: step.label(), steps: vec![step] }
    }
}

/// So sieht der Befehl in der Konsole aus. Argumente mit Leerzeichen in
/// Anführungszeichen – genau so, wie Rust sie unter Windows auch übergibt.
fn display_line(program: &str, args: &[String]) -> String {
    let shown: Vec<String> = args
        .iter()
        .map(|a| if a.contains(' ') { format!("\"{a}\"") } else { a.clone() })
        .collect();
    if shown.is_empty() {
        program.to_string()
    } else {
        format!("{program} {}", shown.join(" "))
    }
}

/// Ergebnis eines einzelnen Schritts.
#[derive(Debug, Clone, Default)]
struct StepResult {
    code: Option<i32>,
    /// Vom Benutzer abgebrochen (zählt nicht als Fehler).
    killed: bool,
    /// Prozess liess sich nicht starten.
    error: Option<String>,
}

#[derive(Debug, Default)]
struct Outcome {
    exit_code: Option<i32>,
    /// 1-basiert: welcher Schritt zuerst gescheitert ist.
    failed_step: Option<u32>,
    error: Option<String>,
    /// Indizes der ausgeführten Schritte (für Tests).
    #[allow(dead_code)]
    ran: Vec<usize>,
}

/// Die Ablauf-Logik – ohne Prozesse, damit sie testbar ist.
///
/// * Scheitert ein Schritt, werden die restlichen Schritte übersprungen.
/// * Bei Abbruch ebenso.
/// * Ausnahme: `restore`-Schritte laufen trotzdem, wenn vorher ein
///   `disruptive`-Schritt lief (renew nach release, aktivieren nach deaktivieren).
/// * `always`-Schritte laufen nach einem Fehler weiter (nicht nach Abbruch).
///
/// `run(index, step, recovery)` führt einen Schritt aus; `recovery = true`
/// heisst: läuft nur noch zur Wiederherstellung.
fn execute_steps<C, R>(steps: &[Step], cancelled: C, mut run: R) -> Outcome
where
    C: Fn() -> bool,
    R: FnMut(usize, &Step, bool) -> StepResult,
{
    let mut dirty = false; // Verbindung getrennt und noch nicht wiederhergestellt
    let mut failed: Option<(u32, Option<i32>)> = None;
    let mut last_code = None;
    let mut out = Outcome::default();

    for (i, step) in steps.iter().enumerate() {
        let cancel = cancelled();
        let stopping = cancel || failed.is_some();
        let recover = step.restore && dirty;
        let skip = if cancel { !recover } else { failed.is_some() && !(recover || step.always) };
        if skip {
            continue;
        }
        if step.disruptive {
            dirty = true; // schon beim Versuch: auch ein halber release kann trennen
        }
        out.ran.push(i);
        let r = run(i, step, stopping);
        if matches!(step.kind, StepKind::Wait { .. }) {
            continue;
        }
        let ok = r.error.is_none() && r.code == Some(0);
        last_code = r.code;
        if out.error.is_none() {
            out.error = r.error;
        }
        if ok {
            if step.restore {
                dirty = false;
            }
        } else if !r.killed && failed.is_none() {
            failed = Some((i as u32 + 1, r.code));
        }
    }

    out.failed_step = failed.map(|f| f.0);
    out.exit_code = failed.map_or(last_code, |f| f.1);
    out
}

// ---------------------------------------------------------------------------
// Laufende Abläufe (Tauri-State)
// ---------------------------------------------------------------------------

/// Ein laufender Ablauf.
struct Running {
    /// Der Prozess des aktuellen Schritts (None während "warten").
    child: Mutex<Option<Child>>,
    /// Zähler statt true/false: So erkennt ein Wiederherstellungs-Schritt,
    /// ob ER abgebrochen wurde oder ob der Abbruch schon vorher kam.
    cancels: AtomicU32,
}

impl Running {
    fn cancels(&self) -> u32 {
        self.cancels.load(Ordering::SeqCst)
    }

    fn cancel(&self) {
        self.cancels.fetch_add(1, Ordering::SeqCst);
        if let Some(child) = lock(&self.child).as_mut() {
            // Fehler ignorieren: Der Prozess kann gerade von selbst beendet sein.
            let _ = child.kill();
        }
    }
}

/// Tauri-State: alle aktuell laufenden Abläufe, Schlüssel = runId.
#[derive(Default)]
pub struct Runner {
    running: Mutex<HashMap<u32, Arc<Running>>>,
}

impl Runner {
    fn map(&self) -> MutexGuard<'_, HashMap<u32, Arc<Running>>> {
        lock(&self.running)
    }

    /// Beendet alle laufenden Prozesse (z. B. beim Schliessen der App,
    /// sonst würde ein `ping -t` unsichtbar weiterlaufen).
    pub fn kill_all(&self) {
        for r in self.map().values() {
            r.cancel();
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    // Bei panic=abort gibt es kein "vergiftetes" Mutex, aber sicher ist sicher.
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
struct StepEvent {
    run_id: u32,
    index: u32,
    total: u32,
    label: String,
    recovery: bool,
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
    failed_step: Option<u32>,
    error: Option<String>,
}

/// Startet Ping oder Traceroute. Die `run_id` vergibt das Frontend, damit
/// es Events schon zuordnen kann, bevor dieser Aufruf zurückkehrt.
#[tauri::command]
pub fn run_command(
    app: AppHandle,
    runner: State<'_, Runner>,
    run_id: u32,
    command: NetCommand,
) -> Result<(), String> {
    let plan = build_command(&command)?;
    start_plan(app, &runner, run_id, plan)
}

/// Startet eine Aktion aus der festen Liste (siehe `actions.rs`).
/// `adapter`: Name des Adapters oder None = alle Adapter.
#[tauri::command]
pub fn run_action(
    app: AppHandle,
    runner: State<'_, Runner>,
    run_id: u32,
    action: crate::actions::ActionId,
    adapter: Option<String>,
) -> Result<(), String> {
    let plan = crate::actions::plan(action, adapter.as_deref())?;
    start_plan(app, &runner, run_id, plan)
}

/// Bricht einen laufenden Ablauf ab (aktueller Prozess wird beendet).
#[tauri::command]
pub fn cancel_command(runner: State<'_, Runner>, run_id: u32) -> Result<(), String> {
    let running = runner.map().get(&run_id).cloned();
    if let Some(r) = running {
        r.cancel();
    }
    Ok(()) // läuft er schon nicht mehr, ist das kein Fehler
}

fn start_plan(app: AppHandle, runner: &Runner, run_id: u32, plan: Plan) -> Result<(), String> {
    let running = register_plan(runner, run_id, &plan)?;
    // Der ganze Ablauf läuft in einem eigenen Thread – das Fenster bleibt bedienbar.
    std::thread::spawn(move || {
        execute_plan(&app, run_id, &running, &plan);
    });
    Ok(())
}

/// Ergebnis eines Ablaufs (für Module, die selbst auf das Ende warten, z. B. IP-Profile).
#[derive(Debug, Clone)]
pub struct PlanResult {
    pub exit_code: Option<i32>,
    pub cancelled: bool,
    pub failed_step: Option<u32>,
    pub error: Option<String>,
}

impl PlanResult {
    /// Alle Schritte erfolgreich und nicht abgebrochen?
    pub fn ok(&self) -> bool {
        !self.cancelled && self.failed_step.is_none() && self.error.is_none() && self.exit_code == Some(0)
    }
}

/// Wie `start_plan`, aber blockierend: kehrt erst nach dem letzten Schritt
/// zurück. Nur aus einem eigenen Thread aufrufen (nie aus dem Hauptthread)!
/// Konsolen-Events (`cmd-*`) gehen genauso ans Frontend wie bei Aktionen.
pub fn run_plan_blocking(app: &AppHandle, run_id: u32, plan: Plan) -> Result<PlanResult, String> {
    use tauri::Manager;
    let running = register_plan(&app.state::<Runner>(), run_id, &plan)?;
    Ok(execute_plan(app, run_id, &running, &plan))
}

/// Programme prüfen und den Ablauf im Runner eintragen (für Abbruch/Beenden).
fn register_plan(runner: &Runner, run_id: u32, plan: &Plan) -> Result<Arc<Running>, String> {
    // Programmpfade vorab prüfen – ein nicht verfügbares Programm fällt so
    // sofort auf und nicht erst mitten im Ablauf.
    for step in &plan.steps {
        if let StepKind::Run { program, .. } = &step.kind {
            program_path(program)?;
        }
    }
    let running = Arc::new(Running { child: Mutex::new(None), cancels: AtomicU32::new(0) });
    let mut map = runner.map();
    if map.contains_key(&run_id) {
        return Err("Interner Fehler: runId wird bereits verwendet.".into());
    }
    map.insert(run_id, running.clone());
    Ok(running)
}

/// Führt einen eingetragenen Ablauf aus und sendet alle Events (läuft im aufrufenden Thread).
fn execute_plan(app: &AppHandle, run_id: u32, running: &Running, plan: &Plan) -> PlanResult {
    let _ = app.emit("cmd-started", StartedEvent { run_id, command_line: plan.title.clone() });
    let total = plan.steps.len() as u32;
    let outcome = execute_steps(
        &plan.steps,
        || running.cancels() > 0,
        |i, step, recovery| {
            // Schrittmarker nur bei echten Abläufen, nicht bei einem einzelnen Ping
            if total > 1 {
                let _ = app.emit(
                    "cmd-step",
                    StepEvent { run_id, index: i as u32 + 1, total, label: step.label(), recovery },
                );
            }
            match &step.kind {
                StepKind::Wait { ms } => {
                    sleep_cancellable(*ms, running);
                    StepResult { code: Some(0), ..Default::default() }
                }
                StepKind::Run { program, args } => run_process(app, run_id, running, program, args),
            }
        },
    );
    let cancelled = running.cancels() > 0;
    {
        use tauri::Manager;
        app.state::<Runner>().map().remove(&run_id);
    }
    let result = PlanResult {
        exit_code: outcome.exit_code,
        cancelled,
        failed_step: outcome.failed_step,
        error: outcome.error,
    };
    let _ = app.emit(
        "cmd-finished",
        FinishedEvent {
            run_id,
            exit_code: result.exit_code,
            cancelled,
            failed_step: result.failed_step,
            error: result.error.clone(),
        },
    );
    result
}

/// Wartet `ms` Millisekunden in kleinen Stücken, damit "Abbrechen" sofort greift.
fn sleep_cancellable(ms: u64, running: &Running) {
    let start_cancels = running.cancels();
    let end = Instant::now() + Duration::from_millis(ms);
    while Instant::now() < end && running.cancels() == start_cancels {
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Einen Prozess starten, Ausgabe streamen, auf das Ende warten.
fn run_process(app: &AppHandle, run_id: u32, running: &Running, program: &str, args: &[String]) -> StepResult {
    let fail = |e: String| {
        let _ = app.emit("cmd-output", OutputEvent { run_id, stream: "stderr", line: e.clone() });
        StepResult { error: Some(e), ..Default::default() }
    };
    let path = match program_path(program) {
        Ok(p) => p,
        Err(e) => return fail(e),
    };

    let mut cmd = Command::new(&path);
    // Argumente als Liste – Rust setzt unter Windows selbst die nötigen
    // Anführungszeichen (z. B. um "vEthernet (Default Switch)").
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Kein schwarzes Konsolenfenster aufblitzen lassen.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let cancels_at_start = running.cancels();
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return fail(format!("{program} konnte nicht gestartet werden: {e}")),
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    *lock(&running.child) = Some(child);

    // Kam der Abbruch genau während des Starts? Dann jetzt beenden.
    if running.cancels() != cancels_at_start {
        if let Some(c) = lock(&running.child).as_mut() {
            let _ = c.kill();
        }
    }

    // Je ein Thread liest stdout und stderr zeilenweise. Sie enden von
    // selbst, sobald der Prozess beendet ist (Pipe zu).
    let mut readers = Vec::new();
    if let Some(pipe) = stdout {
        readers.push(spawn_reader(app.clone(), run_id, "stdout", pipe));
    }
    if let Some(pipe) = stderr {
        readers.push(spawn_reader(app.clone(), run_id, "stderr", pipe));
    }
    for r in readers {
        let _ = r.join();
    }

    // Prozess aus dem State nehmen und Exit-Code abholen (er ist schon beendet).
    let child = lock(&running.child).take();
    let code = child.and_then(|mut c| c.wait().ok()).and_then(|s| s.code());
    StepResult { code, killed: running.cancels() != cancels_at_start, error: None }
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
// Ping / Traceroute zusammenbauen
// ---------------------------------------------------------------------------

fn build_command(cmd: &NetCommand) -> Result<Plan, String> {
    let step = match cmd {
        NetCommand::Ping { target, count } => {
            let target = validate_target(target)?;
            Step::run_args("ping", ping_args(&target, *count)?)
        }
        NetCommand::Tracert { target, resolve } => {
            let target = validate_target(target)?;
            Step::run_args("tracert", tracert_args(&target, *resolve))
        }
    };
    Ok(Plan::single(step))
}

/// Volle Pfade zu System32 verwenden, damit nicht versehentlich eine
/// gleichnamige Datei aus einem anderen Ordner gestartet wird.
#[cfg(windows)]
fn program_path(name: &str) -> Result<String, String> {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    Ok(format!(r"{root}\System32\{name}.exe"))
}

/// Ausserhalb von Windows gibt es kein ipconfig/netsh – nur ping funktioniert.
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

/// Nur die Werte aus `PING_COUNTS` sind erlaubt.
fn validate_count(n: u32) -> Result<u32, String> {
    if PING_COUNTS.contains(&n) {
        Ok(n)
    } else {
        Err("Ungültige Anzahl. Erlaubt sind 2, 4, 8, 16, 32 oder unbegrenzt.".into())
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
/// Zusätzlich muss es einen Adapter mit GENAU diesem Namen geben
/// (Abgleich mit der aktuellen Adapterliste von Windows).
pub fn validate_adapter(name: &str) -> Result<String, String> {
    validate_adapter_chars(name)?;
    let exists = crate::adapters::list_adapters()
        .map(|list| list.iter().any(|a| a.name == name))
        .unwrap_or(false);
    if !exists {
        return Err(format!("Adapter \"{name}\" wurde nicht gefunden."));
    }
    Ok(name.to_string())
}

/// Nur die Zeichenprüfung (ohne Abgleich mit der Adapterliste).
pub(crate) fn validate_adapter_chars(name: &str) -> Result<(), String> {
    if name.trim().is_empty() || name.chars().count() > 128 || name != name.trim() {
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
    Ok(())
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
    use std::cell::RefCell;

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
        for n in ["", "/all", "-x", "WLAN & calc", "a\"b", "x;y", "*", "a|b", " WLAN", "WLAN "] {
            assert!(validate_adapter(n).is_err(), "{n:?} sollte abgelehnt werden");
        }
        for n in ["WLAN", "Ethernet 2", "vEthernet (Default Switch)", "Côté #1"] {
            assert!(validate_adapter_chars(n).is_ok(), "{n:?} sollte erlaubt sein");
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
        for n in PING_COUNTS {
            assert!(validate_count(n).is_ok());
        }
        for n in [0, 1, 3, 5, 100, 1000] {
            assert!(validate_count(n).is_err(), "{n} sollte abgelehnt werden");
        }
        let cmd = NetCommand::Ping { target: "1.1.1.1".into(), count: Some(7) };
        assert!(build_command(&cmd).is_err());
    }

    #[test]
    fn anzeige_mit_anfuehrungszeichen() {
        let s = Step::run_with("netsh", &["interface", "set", "interface"], Some("vEthernet (WSL)"));
        assert_eq!(s.label(), "netsh interface set interface \"vEthernet (WSL)\"");
        assert_eq!(Step::wait(2000).label(), "warten (2 s)");
    }

    // ---- Ablauf-Logik ----------------------------------------------------

    fn ok() -> StepResult {
        StepResult { code: Some(0), ..Default::default() }
    }
    fn err(code: i32) -> StepResult {
        StepResult { code: Some(code), ..Default::default() }
    }
    fn killed() -> StepResult {
        StepResult { code: Some(1), killed: true, error: None }
    }

    /// release → warten → renew
    fn release_renew() -> Vec<Step> {
        vec![
            Step::run("ipconfig", &["/release"]).disruptive(),
            Step::wait(10),
            Step::run("ipconfig", &["/renew"]).restore(),
        ]
    }

    #[test]
    fn ablauf_erfolgreich() {
        let o = execute_steps(&release_renew(), || false, |_, _, _| ok());
        assert_eq!(o.ran, [0, 1, 2]);
        assert_eq!(o.failed_step, None);
        assert_eq!(o.exit_code, Some(0));
    }

    #[test]
    fn fehler_bricht_ab() {
        // flushdns scheitert → nichts weiter (auch kein renew, weil nichts getrennt wurde)
        let steps = vec![
            Step::run("ipconfig", &["/flushdns"]),
            Step::run("ipconfig", &["/release"]).disruptive(),
            Step::wait(10),
            Step::run("ipconfig", &["/renew"]).restore(),
            Step::run("ipconfig", &["/registerdns"]),
        ];
        let o = execute_steps(&steps, || false, |i, _, _| if i == 0 { err(1) } else { ok() });
        assert_eq!(o.ran, [0]);
        assert_eq!(o.failed_step, Some(1));
        assert_eq!(o.exit_code, Some(1));
    }

    #[test]
    fn renew_laeuft_nach_release_fehler() {
        // release meldet Fehler → warten wird übersprungen, renew läuft trotzdem
        let recov = RefCell::new(Vec::new());
        let o = execute_steps(&release_renew(), || false, |i, _, r| {
            recov.borrow_mut().push(r);
            if i == 0 { err(1) } else { ok() }
        });
        assert_eq!(o.ran, [0, 2]);
        assert_eq!(recov.into_inner(), [false, true]);
        assert_eq!(o.failed_step, Some(1)); // der Fehler wird trotzdem gemeldet
        assert_eq!(o.exit_code, Some(1));
    }

    #[test]
    fn abbruch_waehrend_release_holt_ip_zurueck() {
        let cancelled = RefCell::new(false);
        let o = execute_steps(
            &release_renew(),
            || *cancelled.borrow(),
            |i, _, _| {
                if i == 0 {
                    *cancelled.borrow_mut() = true;
                    killed()
                } else {
                    ok()
                }
            },
        );
        assert_eq!(o.ran, [0, 2]);
        assert_eq!(o.failed_step, None); // Abbruch ist kein Fehler
    }

    #[test]
    fn nach_registerdns_kein_weiterer_schritt_bei_abbruch() {
        // Abbruch nach erfolgreichem renew: registerdns wird übersprungen
        let steps = vec![
            Step::run("ipconfig", &["/release"]).disruptive(),
            Step::run("ipconfig", &["/renew"]).restore(),
            Step::run("ipconfig", &["/registerdns"]),
        ];
        let cancelled = RefCell::new(false);
        let o = execute_steps(
            &steps,
            || *cancelled.borrow(),
            |i, _, _| {
                if i == 1 {
                    *cancelled.borrow_mut() = true;
                }
                ok()
            },
        );
        assert_eq!(o.ran, [0, 1]);
    }

    #[test]
    fn always_schritte_laufen_nach_fehler() {
        // Wiederherstellen: Adresse scheitert, DNS läuft trotzdem
        let steps = vec![
            Step::run("netsh", &["a"]).always(),
            Step::run("netsh", &["b"]).always(),
            Step::run("netsh", &["c"]).always(),
        ];
        let o = execute_steps(&steps, || false, |i, _, _| if i == 0 { err(1) } else { ok() });
        assert_eq!(o.ran, [0, 1, 2]);
        assert_eq!(o.failed_step, Some(1));
        // ... aber nicht nach einem Abbruch
        let o = execute_steps(&steps, || true, |_, _, _| ok());
        assert!(o.ran.is_empty());
        // Normale Schritte stoppen weiterhin
        let steps = vec![Step::run("netsh", &["a"]), Step::run("netsh", &["b"])];
        let o = execute_steps(&steps, || false, |_, _, _| err(1));
        assert_eq!(o.ran, [0]);
    }

    #[test]
    fn startfehler_wird_gemeldet() {
        let steps = vec![Step::run("ipconfig", &["/flushdns"])];
        let o = execute_steps(&steps, || false, |_, _, _| StepResult { error: Some("weg".into()), ..Default::default() });
        assert_eq!(o.failed_step, Some(1));
        assert_eq!(o.error.as_deref(), Some("weg"));
    }
}
