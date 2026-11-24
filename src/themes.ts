// Farb-Themes – reine Daten ohne DOM, damit scripts/theme.test.ts den Kontrast
// nachrechnen kann (WCAG: Text und Status-Wörter mind. 4.5:1 zum Hintergrund).
//
// Regeln (gelten in JEDEM Theme, siehe CLAUDE.md):
// * eckig, kein Glow, keine Verläufe – Themes ändern NUR Farben
// * --accent nur für Interaktives (Hover/Fokus invertiert: Schrift = --bg auf --accent)
// * --ok / --err / --warn nur als Textfarbe für Status-Wörter
// * "Cyan" ist der Standard und muss exakt den Werten in styles.css (:root) entsprechen
// * Jedes Theme bringt eine passende Schriftart mit (FONTS unten) – in den
//   Einstellungen lässt sie sich unabhängig vom Theme überschreiben.

export type ThemeId =
  | "cyan"
  | "amber"
  | "phosphor"
  | "paper"
  | "contrast"
  | "dos"
  | "midnight"
  | "synthwave"
  | "sepia"
  | "retro"
  | "arctic"
  | "graphite";

// ---- Schriftarten -------------------------------------------------------------------
//
// Nur Monospace (TUI-Raster!). Zwei Sorten:
// * "windows": in Windows 11 vorinstalliert – kostet nichts.
// * "embedded": als woff2 in der App (nur Zeichensatz "latin", nur Normalgewicht,
//   je ca. 15–20 KB, Lizenz SIL OFL 1.1, Pakete @fontsource/*). Wird erst geladen,
//   wenn man sie wählt (src/fonts.ts) – offline, nie aus dem Internet.
// Fehlende Zeichen (z. B. Blockgrafik █ ░) kommen automatisch aus der nächsten
// Schrift im Stapel (Cascadia Mono / Consolas).
//
// `scale`: manche Schriften wirken bei gleicher Pixelgrösse viel kleiner (VT323 ist
// eine Pixel-Schrift). Die eingestellte Grösse wird damit multipliziert.

export type FontId = "cascadia" | "consolas" | "lucida" | "courier" | "jetbrains" | "plex" | "space" | "vt323" | "sharetech";

export interface FontDef {
  id: FontId;
  label: string;
  /** CSS font-family-Stapel */
  family: string;
  source: "windows" | "embedded";
  /** Name der eingebetteten Schrift (für FontFace), nur bei "embedded" */
  face?: string;
  scale: number;
  description: string;
}

const FALLBACK = `"Cascadia Mono", "Cascadia Code", Consolas, "Lucida Console", ui-monospace, monospace`;

export const FONTS: FontDef[] = [
  { id: "cascadia", label: "Cascadia Mono", family: FALLBACK, source: "windows", scale: 1, description: "Standard, modern" },
  { id: "consolas", label: "Consolas", family: `Consolas, ${FALLBACK}`, source: "windows", scale: 1.05, description: "klassisch Windows-Konsole" },
  { id: "lucida", label: "Lucida Console", family: `"Lucida Console", ${FALLBACK}`, source: "windows", scale: 1, description: "alte cmd.exe" },
  { id: "courier", label: "Courier New", family: `"Courier New", ${FALLBACK}`, source: "windows", scale: 1.05, description: "Schreibmaschine" },
  { id: "jetbrains", label: "JetBrains Mono", family: `"NC JetBrains Mono", ${FALLBACK}`, source: "embedded", face: "NC JetBrains Mono", scale: 1, description: "hohe Buchstaben, gut lesbar" },
  { id: "plex", label: "IBM Plex Mono", family: `"NC IBM Plex Mono", ${FALLBACK}`, source: "embedded", face: "NC IBM Plex Mono", scale: 1, description: "sachlich, IBM-Look" },
  { id: "space", label: "Space Mono", family: `"NC Space Mono", ${FALLBACK}`, source: "embedded", face: "NC Space Mono", scale: 0.95, description: "breit, Retro-Futurismus" },
  { id: "vt323", label: "VT323", family: `"NC VT323", ${FALLBACK}`, source: "embedded", face: "NC VT323", scale: 1.45, description: "Pixel-Schrift wie ein altes Terminal" },
  { id: "sharetech", label: "Share Tech Mono", family: `"NC Share Tech Mono", ${FALLBACK}`, source: "embedded", face: "NC Share Tech Mono", scale: 1.05, description: "schmal, technisch" },
];

export function fontById(id: string): FontDef {
  return FONTS.find((f) => f.id === id) ?? FONTS[0];
}

export interface ThemeColors {
  /** Hintergrund */
  bg: string;
  /** Statusleiste (etwas heller/dunkler als bg) */
  bar: string;
  /** dünne Linien */
  line: string;
  /** normale Schrift */
  text: string;
  /** Labels, Nebensächliches */
  dim: string;
  /** Werte, Titel */
  bright: string;
  /** Interaktives (Hover, Fokus, Auswahl) */
  accent: string;
  /** Status-Wörter: gut / Fehler / Warnung */
  ok: string;
  err: string;
  warn: string;
  /** Abdunklung hinter Dialogen */
  backdrop: string;
}

export interface Theme {
  id: ThemeId;
  label: string;
  description: string;
  /** Schriftart, die das Theme mitbringt */
  font: FontId;
  /** für Scrollbalken, Auswahllisten usw. des WebViews */
  scheme: "dark" | "light";
  colors: ThemeColors;
}

export const THEMES: Theme[] = [
  {
    id: "cyan",
    font: "cascadia",
    label: "Cyan",
    description: "Standard, dunkel",
    scheme: "dark",
    colors: {
      bg: "#0b0e12",
      bar: "#1a2029",
      line: "#2b333d",
      text: "#b8c1cb",
      dim: "#5d6875",
      bright: "#eef2f6",
      accent: "#22d3ee",
      ok: "#4ade80",
      err: "#f87171",
      warn: "#eef2f6", // Warnung im Standard-Theme wie bisher: helle Schrift
      backdrop: "rgba(0, 0, 0, 0.65)",
    },
  },
  {
    id: "amber",
    font: "consolas",
    label: "Amber",
    description: "Bernstein-Terminal",
    scheme: "dark",
    colors: {
      bg: "#0e0b06",
      bar: "#21190b",
      line: "#3d2f15",
      text: "#f0b44c",
      dim: "#9a7130",
      bright: "#ffd88a",
      accent: "#ffb000",
      ok: "#b6e36b",
      err: "#ff7a5c",
      warn: "#ffe9b8",
      backdrop: "rgba(0, 0, 0, 0.7)",
    },
  },
  {
    id: "phosphor",
    font: "lucida",
    label: "Phosphor",
    description: "grün auf schwarz, klassisch",
    scheme: "dark",
    colors: {
      bg: "#050a06",
      bar: "#0e1d11",
      line: "#1f3d25",
      text: "#4ee37c",
      dim: "#2f9a50",
      bright: "#b8ffcb",
      accent: "#39ff6e",
      ok: "#8dffad",
      err: "#ff7466",
      warn: "#f2e86a",
      backdrop: "rgba(0, 0, 0, 0.7)",
    },
  },
  {
    id: "paper",
    font: "plex",
    label: "Papier",
    description: "hell: dunkle Schrift auf hellem Grund",
    scheme: "light",
    colors: {
      bg: "#f5f2ea",
      bar: "#e3ded2",
      line: "#c4bdad",
      text: "#2b2925",
      dim: "#6a655b",
      bright: "#000000",
      accent: "#0e7490",
      ok: "#166534",
      err: "#b42318",
      warn: "#8a4b08",
      backdrop: "rgba(40, 36, 30, 0.45)",
    },
  },
  {
    id: "contrast",
    font: "consolas",
    label: "Kontrast",
    description: "Weiss/Gelb auf Schwarz, hoher Kontrast",
    scheme: "dark",
    colors: {
      bg: "#000000",
      bar: "#1c1c1c",
      line: "#a0a0a0",
      text: "#ffffff",
      dim: "#c8c8c8",
      bright: "#ffff00",
      accent: "#ffff00",
      ok: "#33ff77",
      err: "#ff6b6b",
      warn: "#ffb020",
      backdrop: "rgba(0, 0, 0, 0.8)",
    },
  },
  {
    id: "dos",
    font: "lucida",
    label: "DOS-Blau",
    description: "weiss auf blau, wie alte Dateimanager",
    scheme: "dark",
    colors: {
      bg: "#0000aa",
      bar: "#000066",
      line: "#5555ff",
      text: "#e0e0e0",
      dim: "#9a9aff",
      bright: "#ffffff",
      accent: "#55ffff",
      ok: "#55ff55",
      err: "#ff7b7b",
      warn: "#ffff55",
      backdrop: "rgba(0, 0, 40, 0.6)",
    },
  },
  {
    id: "midnight",
    font: "jetbrains",
    label: "Mitternacht",
    description: "dunkelblau mit Violett",
    scheme: "dark",
    colors: {
      bg: "#0f1226",
      bar: "#1b2040",
      line: "#2d3460",
      text: "#c7cbe8",
      dim: "#7077a8",
      bright: "#ffffff",
      accent: "#a78bfa",
      ok: "#6ee7a8",
      err: "#ff8f8f",
      warn: "#fde68a",
      backdrop: "rgba(5, 6, 20, 0.7)",
    },
  },
  {
    id: "synthwave",
    font: "space",
    label: "Synthwave",
    description: "Lila und Pink, 80er-Neon (ohne Glow)",
    scheme: "dark",
    colors: {
      bg: "#1a0b2e",
      bar: "#2b1150",
      line: "#4a2580",
      text: "#e5d4ff",
      dim: "#9a7ec9",
      bright: "#ffffff",
      accent: "#ff5fd2",
      ok: "#5ff2c8",
      err: "#ff8a5c",
      warn: "#ffe066",
      backdrop: "rgba(10, 2, 25, 0.7)",
    },
  },
  {
    id: "sepia",
    font: "courier",
    label: "Sepia",
    description: "hell, altes Papier mit Schreibmaschine",
    scheme: "light",
    colors: {
      bg: "#f3e9d2",
      bar: "#e6d6b3",
      line: "#c9b48a",
      text: "#3b2f20",
      dim: "#76603f",
      bright: "#1e140a",
      accent: "#8b4513",
      ok: "#2f6b1f",
      err: "#a3201a",
      warn: "#7a4a00",
      backdrop: "rgba(50, 35, 15, 0.45)",
    },
  },
  {
    id: "retro",
    font: "vt323",
    label: "Retro-CRT",
    description: "Pixel-Schrift, weisser Phosphor",
    scheme: "dark",
    colors: {
      bg: "#0a0c0f",
      bar: "#161b20",
      line: "#2a3138",
      text: "#d8e2dc",
      dim: "#7d8a83",
      bright: "#ffffff",
      accent: "#9fe8ff",
      ok: "#7dffb0",
      err: "#ff7a7a",
      warn: "#ffd479",
      backdrop: "rgba(0, 0, 0, 0.7)",
    },
  },
  {
    id: "arctic",
    font: "plex",
    label: "Arktis",
    description: "hell, kühles Blaugrau",
    scheme: "light",
    colors: {
      bg: "#eef3f7",
      bar: "#dde6ee",
      line: "#b9c7d3",
      text: "#1f2a35",
      dim: "#5b6b7a",
      bright: "#000000",
      accent: "#1d4ed8",
      ok: "#116632",
      err: "#b91c1c",
      warn: "#92400e",
      backdrop: "rgba(20, 30, 45, 0.4)",
    },
  },
  {
    id: "graphite",
    font: "sharetech",
    label: "Graphit",
    description: "neutrales Grau mit Orange",
    scheme: "dark",
    colors: {
      bg: "#1e1f22",
      bar: "#2b2d31",
      line: "#3c3f45",
      text: "#c9ccd1",
      dim: "#868a92",
      bright: "#f2f3f5",
      accent: "#f5a524",
      ok: "#57d38c",
      err: "#ff6b6b",
      warn: "#f5d76e",
      backdrop: "rgba(0, 0, 0, 0.65)",
    },
  },
];

export function themeById(id: string): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

/** Akzentfarben für das Theme "Cyan". Grün und Rot fehlen absichtlich: die sind für Status-Wörter reserviert. */
export const ACCENTS = [
  { value: "#22d3ee", label: "Cyan" },
  { value: "#fbbf24", label: "Bernstein" },
  { value: "#e879f9", label: "Magenta" },
  { value: "#60a5fa", label: "Blau" },
  { value: "#e5e7eb", label: "Weiss" },
];

/** Schriftgrösse: Bereich und Standard (px) */
export const FONT_MIN = 10;
export const FONT_MAX = 20;
export const FONT_DEFAULT = 13;

/** Zeilenhöhe zur Schriftgrösse – gleiches Verhältnis wie 13 px → 18 px, ganze Pixel (scharfes Raster). */
export function lineHeightFor(fontPx: number): number {
  return Math.round((fontPx * 18) / 13);
}

// ---- Kontrast nach WCAG 2.x (für den Test) ------------------------------------------

/** "#rrggbb" → relative Leuchtdichte */
export function luminance(hex: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`Keine Farbe: ${hex}`);
  const [r, g, b] = m.slice(1).map((x) => {
    const c = parseInt(x, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Kontrastverhältnis 1 … 21 */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
