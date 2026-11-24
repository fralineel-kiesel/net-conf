//! Live-Traffic: Byte-Zähler der Adapter über `GetIfTable2` (InOctets/OutOctets).
//!
//! Ablauf: Das Frontend ruft `traffic_poll` 1× pro Sekunde auf, solange die
//! Seite "Traffic" offen ist (beim Verlassen stoppt der Timer – es läuft dann
//! nichts mehr im Hintergrund). Das Backend merkt sich die letzten Zählerstände
//! samt Zeitpunkt und berechnet daraus die Raten.
//!
//! Robust gegen Zähler-Reset (z. B. Adapter neu gestartet): Ist der neue Zähler
//! kleiner als der alte, wird diese Messung ignoriert statt eine riesige Spitze
//! zu melden. Ebenso nach langer Pause (Seite war zu) – dann beginnt die
//! Messung neu.
//!
//! Angezeigt werden nur Adapter, die auch die Übersicht kennt (Abgleich über
//! die GUID mit GetAdaptersAddresses). So fallen die vielen internen
//! "Filter"-Interfaces von Windows (QoS, WFP …) weg.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Längere Pause zwischen zwei Messungen → neu beginnen (keine Durchschnittsrate über Minuten).
pub const MAX_GAP: Duration = Duration::from_secs(5);

/// Zählerstand eines Adapters (vom Betriebssystem).
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, Clone)]
pub struct IfCounters {
    /// "{GUID}" – passt zu AdapterInfo.id
    pub id: String,
    pub name: String,
    pub description: String,
    pub connected: bool,
    /// true = keine echte Hardware (Hyper-V, VPN, WSL …)
    pub is_virtual: bool,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    /// Link-Geschwindigkeit in bit/s (0 = unbekannt)
    pub rx_link_bps: u64,
    pub tx_link_bps: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IfTraffic {
    pub id: String,
    pub name: String,
    pub description: String,
    pub connected: bool,
    pub is_virtual: bool,
    /// Bytes seit der letzten Messung; None = keine gültige Messung (erste, Reset, Pause)
    pub rx_delta: Option<u64>,
    pub tx_delta: Option<u64>,
    /// Rate in bit/s (aus Delta und echter Zeitspanne)
    pub rx_bps: Option<f64>,
    pub tx_bps: Option<f64>,
    pub rx_link_bps: Option<u64>,
    pub tx_link_bps: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficSample {
    /// Zeit seit der letzten Messung in ms (None = erste Messung)
    pub elapsed_ms: Option<u32>,
    pub interfaces: Vec<IfTraffic>,
}

/// Differenz zweier Zählerstände – None, wenn der Zähler zurückgesetzt wurde.
pub fn counter_delta(prev: u64, cur: u64) -> Option<u64> {
    cur.checked_sub(prev)
}

/// Link-Geschwindigkeit plausibel? Windows meldet für getrennte Adapter
/// manchmal 0 oder u64::MAX.
fn link(bps: u64, connected: bool) -> Option<u64> {
    (connected && bps > 0 && bps < u64::MAX / 2).then_some(bps)
}

/// Zeitpunkt + Zählerstände (rx, tx) je GUID
type Snapshot = (Instant, HashMap<String, (u64, u64)>);

/// Letzter Stand. Tauri-State.
#[derive(Default)]
pub struct Traffic {
    last: Mutex<Option<Snapshot>>,
}

impl Traffic {
    /// Reine Rechenlogik (getestet): Zähler + Zeitpunkt → Raten.
    pub fn update(&self, now: Instant, counters: Vec<IfCounters>) -> TrafficSample {
        let mut guard = self.last.lock().unwrap_or_else(|e| e.into_inner());
        // Nach langer Pause oder beim ersten Mal: kein Vergleich möglich
        let prev = guard.take().filter(|(t, _)| now.duration_since(*t) <= MAX_GAP && now > *t);
        let elapsed = prev.as_ref().map(|(t, _)| now.duration_since(*t));
        let secs = elapsed.map(|d| d.as_secs_f64()).filter(|s| *s > 0.0);

        let mut map = HashMap::new();
        let interfaces = counters
            .into_iter()
            .map(|c| {
                let old = prev.as_ref().and_then(|(_, m)| m.get(&c.id)).copied();
                let rx_delta = old.and_then(|(rx, _)| counter_delta(rx, c.rx_bytes));
                let tx_delta = old.and_then(|(_, tx)| counter_delta(tx, c.tx_bytes));
                map.insert(c.id.clone(), (c.rx_bytes, c.tx_bytes));
                let rate = |d: Option<u64>| match (d, secs) {
                    (Some(d), Some(s)) => Some(d as f64 * 8.0 / s),
                    _ => None,
                };
                IfTraffic {
                    rx_bps: rate(rx_delta),
                    tx_bps: rate(tx_delta),
                    rx_delta,
                    tx_delta,
                    rx_link_bps: link(c.rx_link_bps, c.connected),
                    tx_link_bps: link(c.tx_link_bps, c.connected),
                    id: c.id,
                    name: c.name,
                    description: c.description,
                    connected: c.connected,
                    is_virtual: c.is_virtual,
                }
            })
            .collect();
        *guard = Some((now, map));
        TrafficSample {
            elapsed_ms: elapsed.map(|d| d.as_millis().min(u32::MAX as u128) as u32),
            interfaces,
        }
    }

    /// Messung vergessen (Seite verlassen) – die nächste beginnt neu.
    pub fn reset(&self) {
        *self.last.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

#[tauri::command]
pub async fn traffic_poll(state: tauri::State<'_, Traffic>) -> Result<TrafficSample, String> {
    // GetIfTable2 ist schnell (< 1 ms), blockiert aber kurz – trotzdem nicht im Hauptthread
    let counters = tauri::async_runtime::spawn_blocking(imp::read_counters)
        .await
        .map_err(|e| format!("Interner Fehler: {e}"))??;
    Ok(state.update(Instant::now(), counters))
}

#[tauri::command]
pub fn traffic_reset(state: tauri::State<'_, Traffic>) {
    state.reset();
}

#[cfg(windows)]
mod imp {
    use super::IfCounters;
    use std::collections::HashSet;
    use windows_sys::Win32::Foundation::NO_ERROR;
    use windows_sys::Win32::NetworkManagement::IpHelper::{FreeMibTable, GetIfTable2, MIB_IF_ROW2, MIB_IF_TABLE2};
    use windows_sys::Win32::NetworkManagement::Ndis::IfOperStatusUp;

    fn guid_string(g: &windows_sys::core::GUID) -> String {
        format!(
            "{{{:08X}-{:04X}-{:04X}-{:02X}{:02X}-{:02X}{:02X}{:02X}{:02X}{:02X}{:02X}}}",
            g.data1, g.data2, g.data3, g.data4[0], g.data4[1], g.data4[2], g.data4[3], g.data4[4],
            g.data4[5], g.data4[6], g.data4[7]
        )
    }

    fn utf16_fixed(buf: &[u16]) -> String {
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..len])
    }

    pub fn read_counters() -> Result<Vec<IfCounters>, String> {
        // Nur Adapter, die auch in der Übersicht stehen (GUID-Abgleich)
        let known: HashSet<String> = crate::adapters::list_adapters()?
            .into_iter()
            .map(|a| a.id.to_uppercase())
            .collect();

        let mut table: *mut MIB_IF_TABLE2 = std::ptr::null_mut();
        // SAFETY: Windows legt die Tabelle an; FreeMibTable gibt sie frei.
        let rc = unsafe { GetIfTable2(&mut table) };
        if rc != NO_ERROR || table.is_null() {
            return Err(format!("Die Traffic-Zähler konnten nicht gelesen werden (Code {rc})."));
        }
        let mut out: Vec<IfCounters> = Vec::new();
        // SAFETY: NumEntries Zeilen direkt hintereinander; Zeiger vom Rohzeiger (addr_of!).
        unsafe {
            let count = (*table).NumEntries as usize;
            let rows = std::ptr::addr_of!((*table).Table) as *const MIB_IF_ROW2;
            for row in std::slice::from_raw_parts(rows, count) {
                let id = guid_string(&row.InterfaceGuid);
                // Bitfeld: Bit 0 = HardwareInterface, Bit 1 = FilterInterface
                let flags = row.InterfaceAndOperStatusFlags._bitfield;
                let hardware = flags & 0x01 != 0;
                let filter = flags & 0x02 != 0;
                if filter || !known.contains(&id) || out.iter().any(|c| c.id == id) {
                    continue;
                }
                out.push(IfCounters {
                    id,
                    name: utf16_fixed(&row.Alias),
                    description: utf16_fixed(&row.Description),
                    connected: row.OperStatus == IfOperStatusUp,
                    is_virtual: !hardware,
                    rx_bytes: row.InOctets,
                    tx_bytes: row.OutOctets,
                    rx_link_bps: row.ReceiveLinkSpeed,
                    tx_link_bps: row.TransmitLinkSpeed,
                });
            }
            FreeMibTable(table as *const core::ffi::c_void);
        }
        Ok(out)
    }
}

#[cfg(not(windows))]
mod imp {
    use super::IfCounters;

    pub fn read_counters() -> Result<Vec<IfCounters>, String> {
        Err("Die Traffic-Messung gibt es nur unter Windows.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(id: &str, rx: u64, tx: u64) -> IfCounters {
        IfCounters {
            id: id.into(),
            name: id.into(),
            description: String::new(),
            connected: true,
            is_virtual: false,
            rx_bytes: rx,
            tx_bytes: tx,
            rx_link_bps: 1_000_000_000,
            tx_link_bps: 0,
        }
    }

    #[test]
    fn delta_und_reset() {
        assert_eq!(counter_delta(100, 250), Some(150));
        assert_eq!(counter_delta(250, 100), None); // Reset → ignorieren
        assert_eq!(counter_delta(5, 5), Some(0));
    }

    #[test]
    fn raten() {
        let t = Traffic::default();
        let t0 = Instant::now();
        // erste Messung: noch keine Rate
        let s = t.update(t0, vec![c("A", 1_000, 500)]);
        assert_eq!(s.elapsed_ms, None);
        assert_eq!(s.interfaces[0].rx_bps, None);
        // 2 s später: 250 000 Byte mehr → 1 Mbit/s
        let s = t.update(t0 + Duration::from_secs(2), vec![c("A", 251_000, 500)]);
        assert_eq!(s.elapsed_ms, Some(2000));
        assert_eq!(s.interfaces[0].rx_delta, Some(250_000));
        assert_eq!(s.interfaces[0].rx_bps, Some(1_000_000.0));
        assert_eq!(s.interfaces[0].tx_bps, Some(0.0));
        assert_eq!(s.interfaces[0].rx_link_bps, Some(1_000_000_000));
        assert_eq!(s.interfaces[0].tx_link_bps, None); // 0 = unbekannt
        // Zähler-Reset (Adapter neu gestartet): keine Rate, keine Riesenspitze
        let s = t.update(t0 + Duration::from_secs(3), vec![c("A", 10, 20)]);
        assert_eq!(s.interfaces[0].rx_bps, None);
        // danach geht es normal weiter
        let s = t.update(t0 + Duration::from_secs(4), vec![c("A", 125_010, 20)]);
        assert_eq!(s.interfaces[0].rx_bps, Some(1_000_000.0));
        // neuer Adapter taucht auf: erst beim nächsten Mal eine Rate
        let s = t.update(t0 + Duration::from_secs(5), vec![c("A", 125_010, 20), c("B", 7, 7)]);
        assert_eq!(s.interfaces[1].rx_bps, None);
    }

    #[test]
    fn lange_pause_beginnt_neu() {
        let t = Traffic::default();
        let t0 = Instant::now();
        t.update(t0, vec![c("A", 0, 0)]);
        let s = t.update(t0 + Duration::from_secs(60), vec![c("A", 999_999, 0)]);
        assert_eq!(s.elapsed_ms, None);
        assert_eq!(s.interfaces[0].rx_bps, None);
        t.reset();
        let s = t.update(t0 + Duration::from_secs(61), vec![c("A", 999_999, 0)]);
        assert_eq!(s.interfaces[0].rx_bps, None);
    }
}
