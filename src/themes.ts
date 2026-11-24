// Farb-Themes – reine Daten ohne DOM, damit scripts/theme.test.ts den Kontrast
// nachrechnen kann (WCAG: Text und Status-Wörter mind. 4.5:1 zum Hintergrund).
//
// Regeln (gelten in JEDEM Theme, siehe CLAUDE.md):
// * eckig, kein Glow, keine Verläufe – Themes ändern NUR Farben
// * --accent nur für Interaktives (Hover/Fokus invertiert: Schrift = --bg auf --accent)
// * --ok / --err / --warn nur als Textfarbe für Status-Wörter
// * "Cyan" ist der Standard und muss exakt den Werten in styles.css (:root) entsprechen

export type ThemeId = "cyan" | "amber" | "phosphor" | "paper" | "contrast";

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
  /** für Scrollbalken, Auswahllisten usw. des WebViews */
  scheme: "dark" | "light";
  colors: ThemeColors;
}

export const THEMES: Theme[] = [
  {
    id: "cyan",
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
