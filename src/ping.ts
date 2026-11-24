// Auswertung der ping.exe-Ausgabe, zeilenweise und sprachunabhängig.
//
// Aufbau der Windows-Ausgabe (deutsch/englisch gleich strukturiert):
//   (Leerzeile)
//   Ping wird ausgeführt für 1.1.1.1 mit 32 Bytes Daten:     <- Kopfzeile
//   Antwort von 1.1.1.1: Bytes=32 Zeit=12ms TTL=57            <- Antwort
//   Zeitüberschreitung der Anforderung.                       <- verloren
//   (Leerzeile)
//   Ping-Statistik für 1.1.1.1: ...                           <- ignorieren
//
// Eine Antwort erkennen wir an "=12ms" bzw. "<1ms" – das ist in allen
// Sprachen gleich ("Zeit=12ms", "time=12ms"). Jede andere Zeile im
// Antwortblock zählt als verlorenes Paket.

export type PingLineResult = { kind: "reply"; ms: number } | { kind: "lost" } | null;

const TIME_RE = /[=<]\s*(\d+)\s*ms\b/i;

export class PingStats {
  sent = 0;
  received = 0;
  /** Latenzen in ms; `null` = Paket verloren (für die Sparkline). */
  history: (number | null)[] = [];
  min = Infinity;
  max = 0;
  private sum = 0;
  private phase: "header" | "probes" | "done" = "header";

  /** Eine Ausgabezeile verarbeiten. */
  feed(line: string): PingLineResult {
    const t = line.trim();
    if (this.phase === "done") return null;
    if (this.phase === "header") {
      if (t) this.phase = "probes"; // erste nicht-leere Zeile = Kopfzeile
      return null;
    }
    if (!t) {
      // Leerzeile nach den Antworten = Beginn der Statistik
      if (this.sent > 0) this.phase = "done";
      return null;
    }
    this.sent++;
    const m = TIME_RE.exec(t);
    if (m) {
      // "<1ms" zählt wie bei Windows als 0 ms
      const ms = t.includes("<") ? 0 : Number(m[1]);
      this.received++;
      this.sum += ms;
      this.min = Math.min(this.min, ms);
      this.max = Math.max(this.max, ms);
      this.history.push(ms);
      return { kind: "reply", ms };
    }
    this.history.push(null);
    return { kind: "lost" };
  }

  get lost(): number {
    return this.sent - this.received;
  }

  get lossPercent(): number {
    return this.sent ? Math.round((this.lost / this.sent) * 100) : 0;
  }

  get avg(): number | null {
    return this.received ? Math.round(this.sum / this.received) : null;
  }
}
