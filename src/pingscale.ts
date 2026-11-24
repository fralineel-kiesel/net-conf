// Skala für Block-Graphen (Ping-Latenz, Live-Traffic): ruhig statt zappelig.
//
// Regeln (siehe CLAUDE.md):
// * Nullpunkt ist immer 0 – Balken sind proportional zum Wert.
// * Obergrenze = nächste "schöne" Stufe über dem Maximum der sichtbaren
//   Werte (mind. die kleinste Stufe). Ping: Werte von 1–10 ms → Skala 0–10 ms,
//   ein Sprung von 7 auf 8 ms ist dann nur ein kleiner Unterschied.
// * Hysterese: Die Skala wächst SOFORT, wenn ein Wert sie überschreitet.
//   Sie schrumpft erst, wenn alle sichtbaren Werte über SHRINK_AFTER
//   Messungen hinweg deutlich (≤ 80 %) unter einer kleineren Stufe lagen.
// * Über der grössten Stufe: auf Vielfache der grössten Stufe aufrunden
//   (Ping: volle Sekunden, Traffic: volle 1000 Mbit/s).

/** Stufen des Ping-Graphen in ms */
export const SCALE_STEPS = [10, 20, 50, 100, 200, 500, 1000];
/** Stufen des Traffic-Graphen in Mbit/s */
export const TRAFFIC_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
/** So viele Messungen in Folge muss "deutlich darunter" gelten. */
export const SHRINK_AFTER = 10;
/** "deutlich darunter" = Maximum höchstens 80 % der kleineren Stufe */
const SHRINK_MARGIN = 0.8;

/** Kleinste Stufe ≥ max. Darüber: auf Vielfache der grössten Stufe aufrunden. */
export function niceScale(max: number, steps: readonly number[] = SCALE_STEPS): number {
  for (const step of steps) if (max <= step) return step;
  const top = steps[steps.length - 1];
  return Math.ceil(max / top) * top;
}

/** Skala mit Hysterese über beliebigen Stufen. */
export class StepScale {
  /** aktuelle Obergrenze */
  max: number;
  private calm = 0;
  // Keine "Parameter Property" (constructor(private …)) – das versteht Node
  // im Strip-Modus der Tests nicht.
  private readonly steps: readonly number[];

  constructor(steps: readonly number[]) {
    this.steps = steps;
    this.max = steps[0];
  }

  reset(): void {
    this.max = this.steps[0];
    this.calm = 0;
  }

  /**
   * Nach JEDER neuen Messung aufrufen (auch ohne Wert),
   * mit den Werten, die der Graph gerade zeigt. `null` = kein Wert.
   */
  update(visible: (number | null)[]): number {
    const values = visible.filter((v): v is number => v !== null);
    const peak = values.length ? Math.max(...values) : 0;

    const needed = niceScale(peak, this.steps);
    if (needed > this.max) {
      // wachsen: sofort
      this.max = needed;
      this.calm = 0;
      return this.max;
    }

    // schrumpfen: nur mit Abstand und nach mehreren ruhigen Messungen
    const smaller = niceScale(peak / SHRINK_MARGIN, this.steps);
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

/** Ping-Graph: Stufen in ms (10 … 1000) */
export class LatencyScale extends StepScale {
  constructor() {
    super(SCALE_STEPS);
  }
}

/** Traffic-Graph: Stufen in Mbit/s (1 … 1000) */
export class TrafficScale extends StepScale {
  constructor() {
    super(TRAFFIC_STEPS);
  }
}
