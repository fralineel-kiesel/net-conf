// Einstellungen (nur Frontend, gespeichert im localStorage des WebViews).
import { ensureFont } from "./fonts";
import { DEFAULTS, sanitizeSettings, type Settings } from "./settingsdata";
import { ACCENTS, FONT_DEFAULT, FONT_MAX, FONT_MIN, FONTS, fontById, lineHeightFor, THEMES, themeById, type FontId, type ThemeId } from "./themes";
import { prefs } from "./ui/dom";

export { ACCENTS, FONT_DEFAULT, FONT_MAX, FONT_MIN, FONTS, THEMES };

export { CONSOLE_LINES, DEFAULTS, type PingCount, type Settings, type ViewId } from "./settingsdata";

function load(): Settings {
  try {
    return sanitizeSettings(JSON.parse(prefs.get("settings", "{}")));
  } catch {
    return { ...DEFAULTS, keybindings: [] };
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
  document.documentElement.classList.toggle("no-blink", !settings.cursorBlink);
}

/** Alle Einstellungen ersetzen (Import, Zurücksetzen) – vorher geprüft. */
export function replaceSettings(next: Settings): void {
  updateSettings(sanitizeSettings(next));
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
