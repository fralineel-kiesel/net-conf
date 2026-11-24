// Einstellungen (nur Frontend, gespeichert im localStorage des WebViews).
import { ensureFont } from "./fonts";
import { ACCENTS, FONT_DEFAULT, FONT_MAX, FONT_MIN, FONTS, fontById, lineHeightFor, THEMES, themeById, type FontId, type ThemeId } from "./themes";
import { prefs } from "./ui/dom";
import { validateTarget } from "./validate";

export { ACCENTS, FONT_DEFAULT, FONT_MAX, FONT_MIN, FONTS, THEMES };

export type ViewId = "overview" | "actions" | "tests" | "tables" | "lan" | "wifi" | "traffic" | "tools" | "settings";

export interface Settings {
  /** Farb-Theme (src/themes.ts) */
  theme: ThemeId;
  /** Akzentfarbe – nur im Theme "Cyan" wählbar, die anderen Themes bringen ihre eigene mit */
  accent: string;
  /** Schriftart: "theme" = die des Themes, sonst fest gewählt (themes.ts → FONTS) */
  font: FontId | "theme";
  /** Schriftgrösse in px (10–20), Strg +/-/0 */
  fontSize: number;
  /** Beim Start nach Updates suchen (höchstens 1× pro 24 h) */
  updateCheck: boolean;
  pingTarget: string;
  consoleLines: number;
  /** "last" = zuletzt verwendete Ansicht */
  startView: ViewId | "last";
}

export const CONSOLE_LINES = [5, 8, 12, 16];

export const DEFAULTS: Settings = {
  theme: "cyan",
  accent: "#22d3ee",
  font: "theme",
  fontSize: FONT_DEFAULT,
  updateCheck: true,
  pingTarget: "1.1.1.1",
  consoleLines: 8,
  startView: "last",
};

function load(): Settings {
  try {
    const raw = JSON.parse(prefs.get("settings", "{}")) as Partial<Settings>;
    const s = { ...DEFAULTS, ...raw };
    // Ungültige gespeicherte Werte durch Standardwerte ersetzen
    if (!ACCENTS.some((a) => a.value === s.accent)) s.accent = DEFAULTS.accent;
    if (!THEMES.some((t) => t.id === s.theme)) s.theme = DEFAULTS.theme;
    if (s.font !== "theme" && !FONTS.some((f) => f.id === s.font)) s.font = DEFAULTS.font;
    if (!Number.isInteger(s.fontSize) || s.fontSize < FONT_MIN || s.fontSize > FONT_MAX) s.fontSize = DEFAULTS.fontSize;
    if (typeof s.updateCheck !== "boolean") s.updateCheck = DEFAULTS.updateCheck;
    if (!CONSOLE_LINES.includes(s.consoleLines)) s.consoleLines = DEFAULTS.consoleLines;
    if (validateTarget(s.pingTarget)) s.pingTarget = DEFAULTS.pingTarget;
    return s;
  } catch {
    return { ...DEFAULTS };
  }
}

export const settings: Settings = load();
const listeners = new Set<() => void>();

export function onSettingsChange(fn: () => void): void {
  listeners.add(fn);
}

export function updateSettings(patch: Partial<Settings>): void {
  Object.assign(settings, patch);
  prefs.set("settings", JSON.stringify(settings));
  applySettings();
  for (const fn of listeners) fn();
}

/** Einstellungen auf die Oberfläche anwenden (CSS-Variablen). */
export function applySettings(): void {
  const root = document.documentElement.style;
  const theme = themeById(settings.theme);
  // Alle Farben des Themes als Variablen (z. B. --bg, --text, --ok)
  for (const [key, value] of Object.entries(theme.colors)) root.setProperty(`--${key}`, value);
  // Eigene Akzentfarbe gibt es nur im Standard-Theme
  if (theme.id === "cyan") root.setProperty("--accent", settings.accent);
  root.setProperty("color-scheme", theme.scheme);
  document.documentElement.dataset.theme = theme.id;
  // Schriftart (vom Theme oder fest gewählt). Manche Schriften wirken kleiner →
  // die eingestellte Grösse wird mit `scale` multipliziert (z. B. VT323 × 1.45).
  const font = activeFont();
  ensureFont(font.id);
  root.setProperty("--font", font.family);
  const px = Math.round(settings.fontSize * font.scale);
  root.setProperty("--fs", `${px}px`);
  root.setProperty("--lh", `${lineHeightFor(px)}px`);
  root.setProperty("--console-lines", String(settings.consoleLines));
}

/** Schriftgrösse ändern (Strg +/-/0). Gibt die neue Grösse zurück. */
export function setFontSize(px: number): number {
  const v = Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(px)));
  if (v !== settings.fontSize) updateSettings({ fontSize: v });
  return v;
}

/** Aktuell verwendete Schriftart */
export function activeFont() {
  return fontById(settings.font === "theme" ? themeById(settings.theme).font : settings.font);
}

/** Schriftart wählen ("theme" = die des Themes) */
export function setFont(id: FontId | "theme"): void {
  if (id !== settings.font) updateSettings({ font: id });
}

/** Theme wechseln (Einstellungen und Befehlspalette) */
export function setTheme(id: ThemeId): void {
  if (id !== settings.theme) updateSettings({ theme: id });
}
