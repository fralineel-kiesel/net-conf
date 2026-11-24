// Block-Graph auf einem Canvas, 3 Textzeilen hoch – für Ping-Latenz,
// Live-Traffic und WLAN-Signal.
//
// Warum Canvas statt Blockzeichen (▁▂▃█)? Bei mehreren Textzeilen hängt es
// von der Schrift ab, ob zwischen den Zeilen Lücken entstehen. Der Canvas
// zeichnet exakt – im gleichen Stil: eckig, ohne Glow, in der Akzentfarbe.
//
// * Eine Spalte = eine Messung, genau 1 Zeichen breit (wie ein Textraster).
// * Höhe in 3 × 8 = 24 Stufen (wie drei Zeilen Blockzeichen).
// * Neueste Messung rechts, der Graph läuft nach links durch.
// * `null` = kein Wert: Standard "×" in Fehlerfarbe auf der Grundlinie
//   (Ping: keine Antwort). Mit `nullMark: "none"` bleibt die Spalte leer.
// * Werte > 0 sind immer mind. 1 Stufe hoch (Ping < 1 ms bleibt sichtbar).
//   Mit `zeroEmpty: true` zeichnet ein Wert von genau 0 keinen Balken
//   (Traffic: Stillstand = leer).
// * Es werden so viele Messungen gezeigt, wie in die Breite passen.
// * Mini-Variante (`mini: true`) für den Ping-Monitor: 1 Zeile = 8 Stufen,
//   Skala nur als kurzer Text rechts ("50 ms").
import { h } from "./dom";

export interface LatencyGraph {
  el: HTMLElement;
  /** Wie viele Messungen passen gerade in die Breite? */
  capacity(): number;
  /** Zeichnen: `history` = alle Messungen (null = kein Wert), `scaleMax` in der Einheit des Graphen */
  render(history: (number | null)[], scaleMax: number): void;
}

export interface GraphOptions {
  mini?: boolean;
  /** Einheit für die Skala, Standard "ms" */
  unit?: string;
  /** Darstellung von `null`: "x" (Standard) oder "none" (leer) */
  nullMark?: "x" | "none";
  /** Text neben dem × (Standard "keine Antwort") */
  nullLabel?: string;
  /** true: Wert 0 = kein Balken */
  zeroEmpty?: boolean;
  /** Bezeichnung für Screenreader */
  label?: string;
}

/** Skalen-Zahl ohne unnötige Nachkommastellen, deutsches Komma */
function fmtScale(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toLocaleString("de-CH", { maximumFractionDigits: 1 });
}

export function createLatencyGraph(opts: GraphOptions = {}): LatencyGraph {
  const mini = opts.mini === true;
  const unit = opts.unit ?? "ms";
  const nullMark = opts.nullMark ?? "x";
  const LEVELS = (mini ? 1 : 3) * 8;
  const canvas = h("canvas", { class: "lgraph-canvas", "aria-hidden": "true" });
  const scaleLabel = h("div", {}, "");
  const lostLabel = h("div", { class: "dim" }, "");
  const axis = mini
    ? h("div", { class: "lgraph-axis dim" }, scaleLabel)
    : h("div", { class: "lgraph-axis" }, scaleLabel, h("div", {}, " "), lostLabel);
  const el = h(
    "div",
    { class: mini ? "lgraph lgraph-mini" : "lgraph", role: "img", "aria-label": opts.label ?? "Latenzverlauf" },
    canvas,
    axis,
  );

  // Breite eines Zeichens messen (Monospace) – daraus ergibt sich die Spaltenbreite.
  let colW = 8;
  const measure = () => {
    const probe = h("span", { class: "lgraph-probe" }, "0".repeat(20));
    el.append(probe);
    const w = probe.getBoundingClientRect().width / 20;
    probe.remove();
    if (w > 0) colW = w;
  };

  let last: { history: (number | null)[]; scaleMax: number } = { history: [], scaleMax: 10 };

  // Unsichtbar (anderer Reiter) ist die Breite 0 – dann die letzte bekannte nehmen,
  // damit die Skala weiter mit allen sichtbaren Werten rechnet.
  let lastCap = 60;
  const capacity = () => {
    if (canvas.clientWidth > 0) lastCap = Math.max(1, Math.floor(canvas.clientWidth / colW));
    return lastCap;
  };

  const render = (history: (number | null)[], scaleMax: number) => {
    last = { history, scaleMax };
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    scaleLabel.textContent = mini
      ? `${fmtScale(scaleMax).padStart(4)} ${unit}`
      : `Skala 0-${fmtScale(scaleMax)} ${unit}`;
    if (cssW === 0 || cssH === 0) return; // unsichtbar (anderer Reiter)

    // Für scharfe Kanten in Gerätepixeln zeichnen
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(cssW * dpr);
    const hgt = Math.round(cssH * dpr);
    if (canvas.width !== w || canvas.height !== hgt) {
      canvas.width = w;
      canvas.height = hgt;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const css = getComputedStyle(document.documentElement);
    const color = (name: string) => css.getPropertyValue(name).trim();

    ctx.clearRect(0, 0, w, hgt);
    // Grundlinie (1px, Linienfarbe)
    ctx.fillStyle = color("--line");
    ctx.fillRect(0, hgt - Math.max(1, Math.round(dpr)), w, Math.max(1, Math.round(dpr)));

    const cap = capacity();
    const data = history.slice(-cap);
    const offset = cap - data.length; // rechtsbündig: neueste Messung ganz rechts
    const gap = Math.max(1, Math.round(dpr)); // 1px Abstand zwischen den Balken
    const colPx = colW * dpr;

    let lost = 0;
    data.forEach((v, i) => {
      const x0 = Math.round((offset + i) * colPx);
      const x1 = Math.round((offset + i + 1) * colPx) - gap;
      if (v === null) {
        if (nullMark === "none") return;
        lost++;
        ctx.fillStyle = color("--err");
        ctx.font = `${(mini ? 11 : 13) * dpr}px ${color("--font") || "monospace"}`;
        ctx.textBaseline = "bottom";
        ctx.textAlign = "center";
        ctx.fillText("×", (x0 + x1) / 2, hgt);
        return;
      }
      if (opts.zeroEmpty && v <= 0) return;
      // Stufe 1..24: proportional ab 0, aber jeder Wert > 0 bleibt sichtbar
      const level = Math.min(LEVELS, Math.max(1, Math.round((v / scaleMax) * LEVELS)));
      const barH = Math.round((level / LEVELS) * hgt);
      ctx.fillStyle = color("--accent");
      ctx.fillRect(x0, hgt - barH, Math.max(1, x1 - x0), barH);
    });

    lostLabel.replaceChildren();
    if (lost > 0) lostLabel.append(h("span", { class: "tag-err" }, "×"), ` ${opts.nullLabel ?? "keine Antwort"}`);
  };

  // Bei Grössenänderung neu messen und neu zeichnen
  new ResizeObserver(() => {
    measure();
    render(last.history, last.scaleMax);
  }).observe(canvas);

  return { el, capacity, render };
}
