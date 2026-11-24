// Einstellungen (nur Frontend, gespeichert im localStorage des WebViews).
import { prefs } from "./ui/dom";
import { validateTarget } from "./validate";

export type ViewId = "overview" | "actions" | "tests" | "tables" | "lan" | "wifi" | "traffic" | "tools" | "settings";

export interface Settings {
  accent: string;
  pingTarget: string;
  consoleLines: number;
  /** "last" = zuletzt verwendete Ansicht */
  startView: ViewId | "last";
}

/** Akzentfarben. Grün und Rot fehlen absichtlich: die sind für Status-Wörter reserviert. */
export const ACCENTS = [
  { value: "#22d3ee", label: "Cyan" },
  { value: "#fbbf24", label: "Bernstein" },
  { value: "#e879f9", label: "Magenta" },
  { value: "#60a5fa", label: "Blau" },
  { value: "#e5e7eb", label: "Weiss" },
];

export const CONSOLE_LINES = [5, 8, 12, 16];

export const DEFAULTS: Settings = {
  accent: "#22d3ee",
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
  root.setProperty("--accent", settings.accent);
  root.setProperty("--console-lines", String(settings.consoleLines));
}
