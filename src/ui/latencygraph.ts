// Latenz-Graph für Ping: eckige Balken auf einem Canvas, 3 Textzeilen hoch.
//
// Warum Canvas statt Blockzeichen (▁▂▃█)? Bei mehreren Textzeilen hängt es
// von der Schrift ab, ob zwischen den Zeilen Lücken entstehen. Der Canvas
// zeichnet exakt – im gleichen Stil: eckig, ohne Glow, in der Akzentfarbe.
//
// * Eine Spalte = eine Messung, genau 1 Zeichen breit (wie ein Textraster).
// * Höhe in 3 × 8 = 24 Stufen (wie drei Zeilen Blockzeichen).
// * Neueste Messung rechts, der Graph läuft nach links durch.
// * Keine Antwort: "×" in Fehlerfarbe auf der Grundlinie (nicht Höhe 0).
// * Es werden so viele Messungen gezeigt, wie in die Breite passen.
import { h } from "./dom";

const ROWS = 3;
const LEVELS = ROWS * 8;

export interface LatencyGraph {
  el: HTMLElement;
  /** Wie viele Messungen passen gerade in die Breite? */
  capacity(): number;
  /** Zeichnen: `history` = alle Messungen (null = keine Antwort), `scaleMax` in ms */
  render(history: (number | null)[], scaleMax: number): void;
}

export function createLatencyGraph(): LatencyGraph {
  const canvas = h("canvas", { class: "lgraph-canvas", "aria-hidden": "true" });
  const scaleLabel = h("div", {}, "");
  const lostLabel = h("div", { class: "dim" }, "");
  const axis = h("div", { class: "lgraph-axis" }, scaleLabel, h("div", {}, " "), lostLabel);
  const el = h("div", { class: "lgraph", role: "img", "aria-label": "Latenzverlauf" }, canvas, axis);

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

  const capacity = () => Math.max(1, Math.floor(canvas.clientWidth / colW));

  const render = (history: (number | null)[], scaleMax: number) => {
    last = { history, scaleMax };
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    scaleLabel.textContent = `Skala 0-${scaleMax} ms`;
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
        lost++;
        ctx.fillStyle = color("--err");
        ctx.font = `${13 * dpr}px ${color("--font") || "monospace"}`;
        ctx.textBaseline = "bottom";
        ctx.textAlign = "center";
        ctx.fillText("×", (x0 + x1) / 2, hgt);
        return;
      }
      // Stufe 1..24: proportional ab 0 ms, aber jede Antwort bleibt sichtbar
      const level = Math.min(LEVELS, Math.max(1, Math.round((v / scaleMax) * LEVELS)));
      const barH = Math.round((level / LEVELS) * hgt);
      ctx.fillStyle = color("--accent");
      ctx.fillRect(x0, hgt - barH, Math.max(1, x1 - x0), barH);
    });

    lostLabel.replaceChildren();
    if (lost > 0) lostLabel.append(h("span", { class: "tag-err" }, "×"), " keine Antwort");
  };

  // Bei Grössenänderung neu messen und neu zeichnen
  new ResizeObserver(() => {
    measure();
    render(last.history, last.scaleMax);
  }).observe(canvas);

  return { el, capacity, render };
}
