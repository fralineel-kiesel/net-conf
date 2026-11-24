// Kontrast-Test der Themes (ohne Test-Framework): npm test
// Status-Wörter (ONLINE/OFFLINE/Warnung) und Text müssen in jedem Theme mind. 4.5:1 haben.
import { readFileSync } from "node:fs";
import { ACCENTS, contrast, lineHeightFor, THEMES } from "../src/themes.ts";

const eq = (a: unknown, b: unknown, msg: string) => {
  if (a !== b) { console.log("FAIL", msg, JSON.stringify(a), "!=", JSON.stringify(b)); process.exitCode = 1; }
  else console.log("ok  ", msg);
};
const atLeast = (fg: string, bg: string, min: number, msg: string) => {
  const c = contrast(fg, bg);
  eq(c >= min, true, `${msg}: ${c.toFixed(2)}:1 (min. ${min}:1)`);
};

eq(Math.round(contrast("#000000", "#ffffff")), 21, "Formel: Schwarz/Weiss = 21:1");

for (const t of THEMES) {
  const c = t.colors;
  for (const k of ["text", "bright", "accent", "ok", "err", "warn"] as const) atLeast(c[k], c.bg, 4.5, `${t.label}: ${k} auf Hintergrund`);
  for (const k of ["ok", "err", "text"] as const) atLeast(c[k], c.bar, 4.5, `${t.label}: ${k} in der Statusleiste`);
  atLeast(c.bg, c.accent, 4.5, `${t.label}: Hover (Schrift --bg auf --accent)`);
  atLeast(c.dim, c.bg, 3, `${t.label}: gedimmte Labels`);
  eq(c.ok !== c.err, true, `${t.label}: OK und Fehler unterscheidbar`);
}

// Akzentfarben (nur Theme Cyan wählbar)
const cyan = THEMES[0].colors;
for (const a of ACCENTS) {
  atLeast(a.value, cyan.bg, 4.5, `Akzent ${a.label} auf Hintergrund`);
  atLeast(cyan.bg, a.value, 4.5, `Akzent ${a.label}: Hover lesbar`);
}

// Standard-Theme muss exakt den CSS-Variablen in styles.css entsprechen (erster Aufruf ohne JS)
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf-8");
const root = /:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
for (const [k, v] of Object.entries(cyan)) {
  const m = new RegExp(`--${k}:\\s*([^;]+);`).exec(root);
  eq(m?.[1].trim(), v, `styles.css :root --${k} = Theme Cyan`);
}

eq(lineHeightFor(13), 18, "Zeilenhöhe bei 13 px = 18 px (wie bisher)");
eq(lineHeightFor(10), 14, "Zeilenhöhe bei 10 px");
eq(lineHeightFor(20), 28, "Zeilenhöhe bei 20 px");
