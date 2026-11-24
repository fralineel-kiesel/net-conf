// Eigene Tastenkürzel – reine Logik ohne DOM (getestet in scripts/keys.test.ts).
//
// Ein Tastenkürzel verbindet eine Tastenkombination mit einem Befehl der
// Befehlspalette (registry.ts, z. B. "action.flushDns"). Ausgeführt wird genau
// dieselbe Funktion wie in der Palette – also auch mit Admin-Hinweis und
// Bestätigungsdialog.
//
// Kombinationen werden als Text gespeichert, immer in derselben Reihenfolge:
//   "Strg+Umschalt+D", "Alt+P", "F12", "Strg+Pfeil↑"

/** Das Nötigste aus einem KeyboardEvent (so lässt sich auch ohne Browser testen). */
export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey?: boolean;
}

export interface Keybinding {
  /** z. B. "Strg+Umschalt+D" */
  combo: string;
  /** Befehls-ID aus der Registry, z. B. "action.flushDns" */
  command: string;
}

export const MAX_BINDINGS = 50;

/** Sondertasten → deutscher Name */
const NAMED: Record<string, string> = {
  ArrowUp: "Pfeil↑",
  ArrowDown: "Pfeil↓",
  ArrowLeft: "Pfeil←",
  ArrowRight: "Pfeil→",
  Home: "Pos1",
  End: "Ende",
  PageUp: "Bild↑",
  PageDown: "Bild↓",
  Insert: "Einfg",
  Delete: "Entf",
  " ": "Leertaste",
  "+": "Plus",
  "-": "Minus",
};

/** Tasten, die nie ein Kürzel werden (Bedienung von Dialogen, Feldern, Fenster) */
const NEVER = new Set(["Escape", "Enter", "Tab", "Backspace", "CapsLock", "NumLock", "ScrollLock", "ContextMenu", "PrintScreen", "Pause"]);
const MODIFIERS = new Set(["Control", "Alt", "Shift", "Meta", "AltGraph", "OS"]);

/** Taste → Name im Kürzel (oder null, wenn die Taste nicht geht) */
function keyName(e: KeyLike): string | null {
  if (MODIFIERS.has(e.key) || NEVER.has(e.key)) return null;
  if (/^F([1-9]|1\d|2[0-4])$/.test(e.key)) return e.key;
  if (NAMED[e.key]) return NAMED[e.key];
  // Ziffern über den Tasten-Code: Umschalt+1 liefert sonst "!" (je nach Layout)
  const digit = /^Digit(\d)$/.exec(e.code ?? "");
  if (digit) return digit[1];
  const numpad = /^Numpad(\d)$/.exec(e.code ?? "");
  if (numpad) return `Num${numpad[1]}`;
  // Buchstaben und Zeichen so, wie sie auf der Taste stehen (deutsches Layout: Z ist Z)
  if ([...e.key].length === 1) return e.key.toUpperCase();
  return null;
}

/** KeyboardEvent → "Strg+Umschalt+D" (null = keine gültige Kombination, z. B. nur Strg gedrückt) */
export function comboFromEvent(e: KeyLike): string | null {
  if (e.metaKey) return null; // Windows-Taste gehört Windows
  const name = keyName(e);
  if (!name) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Strg");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Umschalt");
  parts.push(name);
  return parts.join("+");
}

/** Fest vergebene Kürzel der App und wichtige Windows-/Eingabe-Kürzel */
export const RESERVED: { combo: string; label: string }[] = [
  ...Array.from({ length: 10 }, (_, i) => ({ combo: `F${i + 1}`, label: i === 4 ? "Neu laden" : "Seitenwechsel" })),
  { combo: "Strg+K", label: "Befehlspalette" },
  { combo: "Strg+Plus", label: "Schrift grösser" },
  { combo: "Strg+=", label: "Schrift grösser" },
  { combo: "Strg+Minus", label: "Schrift kleiner" },
  { combo: "Strg+0", label: "Schrift Standard" },
  { combo: "Strg+Num0", label: "Schrift Standard" },
  { combo: "Strg+A", label: "Alles markieren" },
  { combo: "Strg+C", label: "Kopieren" },
  { combo: "Strg+V", label: "Einfügen" },
  { combo: "Strg+X", label: "Ausschneiden" },
  { combo: "Strg+Z", label: "Rückgängig" },
  { combo: "Strg+Y", label: "Wiederholen" },
  { combo: "Strg+Umschalt+Z", label: "Wiederholen" },
  { combo: "Alt+F4", label: "Fenster schliessen (Windows)" },
  { combo: "Strg+R", label: "Neu laden (WebView)" },
  { combo: "Strg+P", label: "Drucken (WebView)" },
  { combo: "Strg+F", label: "Suchen (WebView)" },
  { combo: "Strg+Umschalt+I", label: "Entwicklerwerkzeuge (WebView)" },
];

/** Hat die Kombination die feste Reihenfolge "Strg+Alt+Umschalt+Taste"? */
function parse(combo: string): { mods: string[]; key: string } | null {
  const parts = combo.split("+");
  const key = parts.pop() ?? "";
  if (!key) return null;
  const order = ["Strg", "Alt", "Umschalt"];
  let last = -1;
  for (const m of parts) {
    const i = order.indexOf(m);
    if (i <= last) return null; // unbekannt, doppelt oder falsche Reihenfolge
    last = i;
  }
  return { mods: parts, key };
}

/** Darf diese Kombination ein eigenes Kürzel werden? Fehlermeldung oder null. */
export function checkCombo(combo: string): string | null {
  const p = parse(combo);
  if (!p) return "Ungültige Tastenkombination.";
  const reserved = RESERVED.find((r) => r.combo === combo);
  if (reserved) return `${combo} ist fest vergeben (${reserved.label}).`;
  const ctrl = p.mods.includes("Strg");
  const alt = p.mods.includes("Alt");
  const fKey = /^F(1[1-9]|2[0-4])$/.test(p.key);
  if (ctrl && alt) {
    // Auf deutschen Tastaturen ist AltGr = Strg+Alt (z. B. AltGr+Q = @)
    return "Strg+Alt ist auf deutschen Tastaturen AltGr (z. B. @, €) – bitte eine andere Kombination wählen.";
  }
  if (!ctrl && !alt && !fKey) {
    return "Bitte mit Strg oder Alt kombinieren – sonst stört das Kürzel beim Tippen. Ohne Zusatztaste gehen nur F11–F24.";
  }
  return null;
}

/** Ist die Kombination schon belegt? Gibt den Befehl zurück (oder null). */
export function findConflict(bindings: Keybinding[], combo: string, exceptIndex = -1): Keybinding | null {
  return bindings.find((b, i) => i !== exceptIndex && b.combo === combo) ?? null;
}

/** Gespeicherte Liste prüfen: Ungültiges, Doppeltes und Fremdes fällt weg. */
export function sanitizeBindings(raw: unknown): Keybinding[] {
  if (!Array.isArray(raw)) return [];
  const out: Keybinding[] = [];
  for (const item of raw) {
    if (out.length >= MAX_BINDINGS) break;
    if (typeof item !== "object" || item === null) continue;
    const { combo, command } = item as Record<string, unknown>;
    if (typeof combo !== "string" || typeof command !== "string") continue;
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(command)) continue;
    if (checkCombo(combo) !== null || findConflict(out, combo)) continue;
    out.push({ combo, command });
  }
  return out;
}
