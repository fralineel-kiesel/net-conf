// Einstellungen – reine Daten und Prüfung ohne DOM (getestet in scripts/settings.test.ts).
// Gespeichert wird im localStorage (settings.ts); hier stehen Standardwerte,
// die Prüfung beim Laden und Export/Import als Text.
import { sanitizeBindings, type Keybinding } from "./keys.ts";
import { ACCENTS, FONT_DEFAULT, FONT_MAX, FONT_MIN, FONTS, THEMES, type FontId, type ThemeId } from "./themes.ts";
import { PING_COUNTS } from "./types.ts";
import { validateTarget } from "./validate.ts";

export type ViewId = "overview" | "actions" | "tests" | "tables" | "lan" | "wifi" | "traffic" | "tools" | "settings";
export const VIEW_IDS: ViewId[] = ["overview", "actions", "tests", "tables", "lan", "wifi", "traffic", "tools", "settings"];

/** Ping-Anzahl: eine aus PING_COUNTS oder "inf" (ping -t) */
export type PingCount = (typeof PING_COUNTS)[number] | "inf";

export interface Settings {
  /** Farb-Theme (src/themes.ts) */
  theme: ThemeId;
  /** Akzentfarbe – nur im Theme "Cyan" wählbar, die anderen Themes bringen ihre eigene mit */
  accent: string;
  /** Schriftart: "theme" = die des Themes, sonst fest gewählt (themes.ts → FONTS) */
  font: FontId | "theme";
  /** Schriftgrösse in px (10–20), Strg +/-/0 */
  fontSize: number;
  /** Block-Cursor in den Überschriften blinkt */
  cursorBlink: boolean;
  /** Beim Start nach Updates suchen (höchstens 1× pro 24 h) */
  updateCheck: boolean;
  pingTarget: string;
  /** Vorauswahl der Ping-Anzahl im Ping-Test */
  pingCount: PingCount;
  consoleLines: number;
  /** Uhrzeit vor jeder Konsolenzeile ("[14:03:22] …") */
  consoleTimestamps: boolean;
  /** Uhr rechts in der Statusleiste */
  statusClock: boolean;
  /** Ping-Monitor beim Start der App automatisch starten (wenn Ziele vorhanden) */
  monitorAutostart: boolean;
  /** "last" = zuletzt verwendete Ansicht */
  startView: ViewId | "last";
  /** Eigene Tastenkürzel → Befehle der Befehlspalette */
  keybindings: Keybinding[];
}

export const CONSOLE_LINES = [5, 8, 12, 16];

export const DEFAULTS: Settings = {
  theme: "cyan",
  accent: "#22d3ee",
  font: "theme",
  fontSize: FONT_DEFAULT,
  cursorBlink: true,
  updateCheck: true,
  pingTarget: "1.1.1.1",
  pingCount: 4,
  consoleLines: 8,
  consoleTimestamps: false,
  statusClock: false,
  monitorAutostart: false,
  startView: "last",
  keybindings: [],
};

const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);

/** Gespeicherte/importierte Werte prüfen. Unbekanntes fällt weg, Ungültiges wird zum Standard. */
export function sanitizeSettings(raw: unknown): Settings {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const d = DEFAULTS;
  const oneOf = <T>(v: unknown, list: readonly T[], fallback: T): T => (list.includes(v as T) ? (v as T) : fallback);
  return {
    theme: oneOf(r.theme, THEMES.map((t) => t.id), d.theme),
    accent: oneOf(r.accent, ACCENTS.map((a) => a.value), d.accent),
    font: oneOf<FontId | "theme">(r.font, ["theme", ...FONTS.map((f) => f.id)], d.font),
    fontSize:
      typeof r.fontSize === "number" && Number.isInteger(r.fontSize) && r.fontSize >= FONT_MIN && r.fontSize <= FONT_MAX
        ? r.fontSize
        : d.fontSize,
    cursorBlink: bool(r.cursorBlink, d.cursorBlink),
    updateCheck: bool(r.updateCheck, d.updateCheck),
    pingTarget: typeof r.pingTarget === "string" && validateTarget(r.pingTarget) === null ? r.pingTarget.trim() : d.pingTarget,
    pingCount: oneOf<PingCount>(r.pingCount, [...PING_COUNTS, "inf"], d.pingCount),
    consoleLines: oneOf(r.consoleLines, CONSOLE_LINES, d.consoleLines),
    consoleTimestamps: bool(r.consoleTimestamps, d.consoleTimestamps),
    statusClock: bool(r.statusClock, d.statusClock),
    monitorAutostart: bool(r.monitorAutostart, d.monitorAutostart),
    startView: oneOf<ViewId | "last">(r.startView, ["last", ...VIEW_IDS], d.startView),
    keybindings: sanitizeBindings(r.keybindings),
  };
}

// ---- Export / Import (Text über die Zwischenablage) -----------------------------

const EXPORT_KIND = "net-conf-settings";

/** Einstellungen als lesbarer JSON-Text (ohne config.json-Daten wie IP-Profile). */
export function exportSettings(s: Settings, version: string): string {
  return JSON.stringify({ kind: EXPORT_KIND, format: 1, appVersion: version, settings: s }, null, 2);
}

/** Text aus der Zwischenablage lesen. Gibt die geprüften Einstellungen zurück – oder eine Fehlermeldung. */
export function importSettings(text: string): { settings: Settings; ignored: string[] } | { error: string } {
  if (text.length > 100_000) return { error: "Der Text ist zu lang für einen Einstellungs-Export." };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: "Das ist kein gültiger Einstellungs-Export (kein JSON)." };
  }
  const d = data as { kind?: unknown; format?: unknown; settings?: unknown };
  if (typeof data !== "object" || data === null || d.kind !== EXPORT_KIND) {
    return { error: "Das ist kein Einstellungs-Export von Net-Conf." };
  }
  if (d.format !== 1) return { error: "Dieses Export-Format kennt diese Version von Net-Conf nicht." };
  if (typeof d.settings !== "object" || d.settings === null) return { error: "Der Export enthält keine Einstellungen." };
  const settings = sanitizeSettings(d.settings);
  // Melden, was nicht übernommen werden konnte (unbekannt oder ungültig)
  const raw = d.settings as Record<string, unknown>;
  const ignored = Object.keys(raw).filter(
    (k) => !(k in DEFAULTS) || JSON.stringify(raw[k]) !== JSON.stringify(settings[k as keyof Settings]),
  );
  return { settings, ignored };
}
