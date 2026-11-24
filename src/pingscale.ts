// Skala für den Ping-Graphen: ruhig statt zappelig.
//
// Regeln (siehe CLAUDE.md):
// * Nullpunkt ist immer 0 ms – Balken sind proportional zur Latenz.
// * Obergrenze = nächste "schöne" Stufe über dem Maximum der sichtbaren
//   Werte (mind. 10 ms). Werte von 1–10 ms → Skala 0–10 ms, ein Sprung
//   von 7 auf 8 ms ist dann nur ein kleiner Unterschied.
// * Hysterese: Die Skala wächst SOFORT, wenn ein Wert sie überschreitet.
//   Sie schrumpft erst, wenn alle sichtbaren Werte über SHRINK_AFTER
//   Messungen hinweg deutlich (≤ 80 %) unter einer kleineren Stufe lagen.

export const SCALE_STEPS = [10, 20, 50, 100, 200, 500, 1000];
/** So viele Messungen in Folge muss "deutlich darunter" gelten. */
export const SHRINK_AFTER = 10;
/** "deutlich darunter" = Maximum höchstens 80 % der kleineren Stufe */
const SHRINK_MARGIN = 0.8;

/** Kleinste Stufe ≥ maxMs. Über 1000 ms: auf volle Sekunden aufrunden. */
export function niceScale(maxMs: number): number {
  for (const step of SCALE_STEPS) if (maxMs <= step) return step;
  return Math.ceil(maxMs / 1000) * 1000;
}

export class LatencyScale {
  /** aktuelle Obergrenze in ms */
  max = SCALE_STEPS[0];
  private calm = 0;

  reset(): void {
    this.max = SCALE_STEPS[0];
    this.calm = 0;
  }

  /**
   * Nach JEDER neuen Messung aufrufen (auch bei Zeitüberschreitung),
   * mit den Werten, die der Graph gerade zeigt. `null` = keine Antwort.
   */
  update(visible: (number | null)[]): number {
    const values = visible.filter((v): v is number => v !== null);
    const peak = values.length ? Math.max(...values) : 0;

    const needed = niceScale(peak);
    if (needed > this.max) {
      // wachsen: sofort
      this.max = needed;
      this.calm = 0;
      return this.max;
    }

    // schrumpfen: nur mit Abstand und nach mehreren ruhigen Messungen
    const smaller = niceScale(peak / SHRINK_MARGIN);
    if (smaller < this.max) {
      this.calm++;
      if (this.calm >= SHRINK_AFTER) {
        this.max = smaller;
        this.calm = 0;
      }
    } else {
      this.calm = 0;
    }
    return this.max;
  }
}
