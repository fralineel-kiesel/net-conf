//! Ping-Monitor: pingt eine Liste von Zielen in festem Intervall – im Backend,
//! damit es weiterläuft, wenn man im Frontend die Seite wechselt.
//!
//! * Pings über das ICMP-Modul (keine ping.exe-Prozesse).
//! * DOWN erst nach 2 Zeitüberschreitungen in Folge (gegen Fehlalarme),
//!   UP sofort bei der nächsten Antwort.
//! * Statuswechsel landen im Ausfall-Log (max. 500 Einträge).
//!
//! Event an das Frontend nach jeder Runde:
//! * `monitor-update` { running, intervalSec, targets, newLog }

use crate::config::{MonitorTarget, MAX_MONITOR_TARGETS, MONITOR_INTERVALS};
use serde::Serialize;
use std::collections::VecDeque;
use std::net::Ipv4Addr;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

/// So viele Messungen behält jedes Ziel für den Mini-Verlauf.
const HISTORY: usize = 120;
const MAX_LOG: usize = 500;
/// Ab so vielen Zeitüberschreitungen in Folge gilt ein Ziel als DOWN.
pub const DOWN_AFTER: u32 = 2;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Statistik eines Ziels (reine Logik, getestet)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Unknown,
    Up,
    Down,
}

/// Statuswechsel, der ins Log gehört.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Transition {
    Down,
    /// wieder erreichbar nach so vielen Sekunden DOWN
    Up { after_sec: u64 },
}

#[derive(Debug, Clone)]
pub struct Stats {
    pub status: Status,
    pub sent: u32,
    pub received: u32,
    sum_ms: u64,
    pub last_ms: Option<u32>,
    pub history: VecDeque<Option<u32>>,
    fail_streak: u32,
    /// Zeitpunkt (Unix-ms) des letzten Statuswechsels
    pub since_ms: Option<u64>,
}

impl Default for Stats {
    fn default() -> Self {
        Stats {
            status: Status::Unknown,
            sent: 0,
            received: 0,
            sum_ms: 0,
            last_ms: None,
            history: VecDeque::with_capacity(HISTORY),
            fail_streak: 0,
            since_ms: None,
        }
    }
}

impl Stats {
    /// Eine Messung eintragen (`None` = keine Antwort). Gibt einen Statuswechsel
    /// zurück, wenn er ins Log soll.
    pub fn record(&mut self, rtt: Option<u32>, now: u64) -> Option<Transition> {
        self.sent += 1;
        if self.history.len() == HISTORY {
            self.history.pop_front();
        }
        self.history.push_back(rtt);
        self.last_ms = rtt;
        match rtt {
            Some(ms) => {
                self.received += 1;
                self.sum_ms += ms as u64;
                self.fail_streak = 0;
                let before = self.status;
                if before == Status::Up {
                    return None;
                }
                let since = self.since_ms.unwrap_or(now);
                self.status = Status::Up;
                self.since_ms = Some(now);
                // Erste Antwort nach dem Start ist kein "wieder da"
                (before == Status::Down).then(|| Transition::Up { after_sec: now.saturating_sub(since) / 1000 })
            }
            None => {
                self.fail_streak += 1;
                if self.fail_streak >= DOWN_AFTER && self.status != Status::Down {
                    self.status = Status::Down;
                    self.since_ms = Some(now);
                    return Some(Transition::Down);
                }
                None
            }
        }
    }

    pub fn avg_ms(&self) -> Option<u32> {
        (self.received > 0).then(|| (self.sum_ms / self.received as u64) as u32)
    }

    pub fn loss_percent(&self) -> f64 {
        if self.sent == 0 {
            0.0
        } else {
            let lost = (self.sent - self.received) as f64;
            (lost * 1000.0 / self.sent as f64).round() / 10.0 // eine Nachkommastelle
        }
    }
}

// ---------------------------------------------------------------------------
// Zustand und Snapshots
// ---------------------------------------------------------------------------

struct Target {
    name: String,
    host: String,
    /// aufgelöste Adresse (einmal pro Start, bei Fehler nächste Runde erneut)
    address: Option<Ipv4Addr>,
    error: Option<String>,
    stats: Stats,
}

impl Target {
    fn new(t: MonitorTarget) -> Target {
        Target { name: t.name, host: t.host, address: None, error: None, stats: Stats::default() }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub time_ms: u64,
    pub name: String,
    pub host: String,
    /// "down" | "up"
    pub kind: &'static str,
    pub after_sec: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetView {
    pub name: String,
    pub host: String,
    pub address: Option<String>,
    /// "unknown" | "up" | "down"
    pub status: &'static str,
    pub last_ms: Option<u32>,
    pub avg_ms: Option<u32>,
    pub sent: u32,
    pub received: u32,
    pub loss_percent: f64,
    pub history: Vec<Option<u32>>,
    pub since_ms: Option<u64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorStatus {
    pub running: bool,
    pub interval_sec: u32,
    pub targets: Vec<TargetView>,
    pub log: Vec<LogEntry>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateEvent {
    running: bool,
    interval_sec: u32,
    targets: Vec<TargetView>,
    new_log: Vec<LogEntry>,
}

struct Inner {
    targets: Vec<Target>,
    interval_sec: u32,
    running: bool,
    /// Wird bei Start/Stop erhöht. Ein Thread mit alter Nummer beendet sich.
    generation: u64,
    log: VecDeque<LogEntry>,
}

impl Inner {
    fn views(&self) -> Vec<TargetView> {
        self.targets
            .iter()
            .map(|t| TargetView {
                name: t.name.clone(),
                host: t.host.clone(),
                address: t.address.map(|a| a.to_string()),
                status: match t.stats.status {
                    Status::Unknown => "unknown",
                    Status::Up => "up",
                    Status::Down => "down",
                },
                last_ms: t.stats.last_ms,
                avg_ms: t.stats.avg_ms(),
                sent: t.stats.sent,
                received: t.stats.received,
                loss_percent: t.stats.loss_percent(),
                history: t.stats.history.iter().copied().collect(),
                since_ms: t.stats.since_ms,
                error: t.error.clone(),
            })
            .collect()
    }

    fn status(&self) -> MonitorStatus {
        MonitorStatus {
            running: self.running,
            interval_sec: self.interval_sec,
            targets: self.views(),
            log: self.log.iter().cloned().collect(),
        }
    }

    fn push_log(&mut self, entry: LogEntry) {
        if self.log.len() == MAX_LOG {
            self.log.pop_front();
        }
        self.log.push_back(entry);
    }
}

/// Tauri-State
pub struct Monitor {
    inner: Arc<Mutex<Inner>>,
}

impl Default for Monitor {
    fn default() -> Self {
        Monitor {
            inner: Arc::new(Mutex::new(Inner {
                targets: Vec::new(),
                interval_sec: 2,
                running: false,
                generation: 0,
                log: VecDeque::new(),
            })),
        }
    }
}

impl Monitor {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Beim Beenden der App: Thread stoppen.
    pub fn stop(&self) {
        let mut g = self.lock();
        g.running = false;
        g.generation += 1;
    }
}

fn lock_arc(inner: &Arc<Mutex<Inner>>) -> MutexGuard<'_, Inner> {
    inner.lock().unwrap_or_else(|e| e.into_inner())
}

/// Ping-Wartezeit passend zum Intervall: muss in die Runde passen.
fn ping_timeout_ms(interval_sec: u32) -> u32 {
    (interval_sec * 800).clamp(500, 2000)
}

// ---------------------------------------------------------------------------
// Tauri-Commands
// ---------------------------------------------------------------------------

/// Ziele und Intervall setzen. Bereits vorhandene Ziele (gleicher Name + Host)
/// behalten ihre Statistik, damit Hinzufügen nicht alles zurücksetzt.
#[tauri::command]
pub fn monitor_set(
    app: AppHandle,
    monitor: State<'_, Monitor>,
    targets: Vec<MonitorTarget>,
    interval_sec: u32,
) -> Result<MonitorStatus, String> {
    if targets.len() > MAX_MONITOR_TARGETS {
        return Err(format!("Höchstens {MAX_MONITOR_TARGETS} Ziele."));
    }
    if !MONITOR_INTERVALS.contains(&interval_sec) {
        return Err("Ungültiges Intervall (erlaubt: 1, 2, 5, 10 s).".into());
    }
    let checked: Vec<MonitorTarget> =
        targets.iter().map(crate::config::check_monitor_target).collect::<Result<_, _>>()?;

    let mut g = monitor.lock();
    let mut old: Vec<Target> = std::mem::take(&mut g.targets);
    g.targets = checked
        .into_iter()
        .map(|t| match old.iter().position(|o| o.name == t.name && o.host == t.host) {
            Some(i) => old.swap_remove(i),
            None => Target::new(t),
        })
        .collect();
    g.interval_sec = interval_sec;
    let status = g.status();
    drop(g);
    emit_update(&app, &status, Vec::new());
    Ok(status)
}

#[tauri::command]
pub fn monitor_start(app: AppHandle, monitor: State<'_, Monitor>) -> Result<MonitorStatus, String> {
    let mut g = monitor.lock();
    if g.targets.is_empty() {
        return Err("Bitte zuerst mindestens ein Ziel hinzufügen.".into());
    }
    if g.running {
        return Ok(g.status());
    }
    g.running = true;
    g.generation += 1;
    let generation = g.generation;
    for t in &mut g.targets {
        // Neue Messreihe: Statistik zurücksetzen, Namen neu auflösen
        t.stats = Stats::default();
        t.address = None;
        t.error = None;
    }
    let status = g.status();
    drop(g);

    let inner = monitor.inner.clone();
    let app2 = app.clone();
    std::thread::spawn(move || run_loop(app2, inner, generation));
    emit_update(&app, &status, Vec::new());
    Ok(status)
}

#[tauri::command]
pub fn monitor_stop(app: AppHandle, monitor: State<'_, Monitor>) -> MonitorStatus {
    monitor.stop();
    let status = monitor.lock().status();
    emit_update(&app, &status, Vec::new());
    status
}

#[tauri::command]
pub fn monitor_status(monitor: State<'_, Monitor>) -> MonitorStatus {
    monitor.lock().status()
}

#[tauri::command]
pub fn monitor_clear_log(monitor: State<'_, Monitor>) {
    monitor.lock().log.clear();
}

fn emit_update(app: &AppHandle, s: &MonitorStatus, new_log: Vec<LogEntry>) {
    let _ = app.emit(
        "monitor-update",
        UpdateEvent { running: s.running, interval_sec: s.interval_sec, targets: s.targets.clone(), new_log },
    );
}

// ---------------------------------------------------------------------------
// Mess-Schleife (eigener Thread)
// ---------------------------------------------------------------------------

fn run_loop(app: AppHandle, inner: Arc<Mutex<Inner>>, generation: u64) {
    loop {
        // Arbeitsliste kopieren – während der Pings ist das Mutex NICHT gesperrt.
        let (work, interval_sec) = {
            let g = lock_arc(&inner);
            if !g.running || g.generation != generation {
                return;
            }
            let work: Vec<(String, String, Option<Ipv4Addr>)> =
                g.targets.iter().map(|t| (t.name.clone(), t.host.clone(), t.address)).collect();
            (work, g.interval_sec)
        };
        let round_start = Instant::now();
        let timeout = ping_timeout_ms(interval_sec);

        // Alle Ziele gleichzeitig pingen (max. 20 = max. Anzahl Ziele)
        let results = crate::icmp::parallel_map(&work, MAX_MONITOR_TARGETS, |(_, host, addr)| {
            let ip = match addr {
                Some(ip) => *ip,
                None => match crate::icmp::resolve_ipv4(host) {
                    Ok(ip) => ip,
                    Err(e) => return (None, None, Some(e)),
                },
            };
            let echo = crate::icmp::ping(ip, timeout);
            let err = match &echo {
                crate::icmp::Echo::Unreachable(m) | crate::icmp::Echo::Error(m) => Some(m.clone()),
                _ => None,
            };
            (Some(ip), echo.rtt(), err)
        });

        // Ergebnisse eintragen (Ziele könnten sich inzwischen geändert haben →
        // Zuordnung über Name + Host, nicht über die Position).
        let now = now_ms();
        let (status, new_log) = {
            let mut g = lock_arc(&inner);
            if !g.running || g.generation != generation {
                return;
            }
            let mut new_log = Vec::new();
            for ((name, host, _), (ip, rtt, err)) in work.iter().zip(results) {
                let Some(t) = g.targets.iter_mut().find(|t| &t.name == name && &t.host == host) else {
                    continue;
                };
                if ip.is_some() {
                    t.address = ip;
                }
                t.error = err;
                if let Some(tr) = t.stats.record(rtt, now) {
                    new_log.push(LogEntry {
                        time_ms: now,
                        name: t.name.clone(),
                        host: t.host.clone(),
                        kind: if tr == Transition::Down { "down" } else { "up" },
                        after_sec: match tr {
                            Transition::Up { after_sec } => Some(after_sec),
                            Transition::Down => None,
                        },
                    });
                }
            }
            for e in &new_log {
                g.push_log(e.clone());
            }
            (g.status(), new_log)
        };
        emit_update(&app, &status, new_log);

        // Bis zur nächsten Runde warten – in kleinen Schritten, damit Stop sofort greift.
        let next = round_start + Duration::from_secs(interval_sec as u64);
        while Instant::now() < next {
            std::thread::sleep(Duration::from_millis(100));
            let g = lock_arc(&inner);
            if !g.running || g.generation != generation {
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn down_erst_nach_zwei_timeouts() {
        let mut s = Stats::default();
        assert_eq!(s.record(Some(10), 1_000), None, "erste Antwort: UP, aber kein Log");
        assert_eq!(s.status, Status::Up);
        assert_eq!(s.record(None, 2_000), None, "ein Timeout ist noch kein Ausfall");
        assert_eq!(s.status, Status::Up);
        assert_eq!(s.record(Some(12), 3_000), None);
        assert_eq!(s.record(None, 4_000), None);
        assert_eq!(s.record(None, 5_000), Some(Transition::Down));
        assert_eq!(s.status, Status::Down);
        assert_eq!(s.record(None, 6_000), None, "DOWN wird nur einmal gemeldet");
        assert_eq!(s.record(Some(9), 33_000), Some(Transition::Up { after_sec: 28 }));
        assert_eq!(s.since_ms, Some(33_000));
    }

    #[test]
    fn nie_erreichbar_wird_down() {
        let mut s = Stats::default();
        assert_eq!(s.record(None, 0), None);
        assert_eq!(s.record(None, 1_000), Some(Transition::Down));
    }

    #[test]
    fn statistik() {
        let mut s = Stats::default();
        for v in [Some(10), None, Some(20), Some(30)] {
            s.record(v, 0);
        }
        assert_eq!(s.sent, 4);
        assert_eq!(s.received, 3);
        assert_eq!(s.avg_ms(), Some(20));
        assert_eq!(s.loss_percent(), 25.0);
        assert_eq!(s.last_ms, Some(30));
        for _ in 0..200 {
            s.record(Some(1), 0);
        }
        assert_eq!(s.history.len(), HISTORY, "Verlauf ist begrenzt");
    }

    #[test]
    fn wartezeit_passt_ins_intervall() {
        assert_eq!(ping_timeout_ms(1), 800);
        assert_eq!(ping_timeout_ms(2), 1600);
        assert_eq!(ping_timeout_ms(10), 2000);
    }
}
