// Zentrale Befehls-Registry für die Befehlspalette (Strg+K).
//
// Jede Seite/Funktion meldet ihre Befehle selbst an – so tauchen neue
// Features automatisch in der Palette auf:
//
//   registerCommand({
//     id: "page.wifi",
//     title: "Gehe zu WLAN",
//     category: "SEITE",
//     hint: "F7",
//     run: () => nav.show("wifi"),
//   });
//
// Befehle mit Parameter (Eingabe "ping 1.1.1.1"):
//
//   registerCommand({
//     id: "test.ping", title: "ping <ziel>", category: "TEST",
//     param: { keyword: "ping", placeholder: "<ziel>", validate: validateTarget },
//     run: (target) => pingHost(target!),
//   });
//
// WICHTIG: `run` muss dieselbe Logik wie die Seite benutzen (inkl. Admin-Hinweis
// und Bestätigungsdialog). Die Palette selbst führt nie etwas an einem Dialog vorbei aus.

export type Category = "SEITE" | "AKTION" | "TEST" | "TOOL" | "EINSTELLUNG";

export interface CommandParam {
  /** erstes Wort der Eingabe, z. B. "ping" */
  keyword: string;
  /** Anzeige, z. B. "<ziel>" */
  placeholder: string;
  /** Gleiche Prüfung wie auf der Seite: Fehlermeldung oder null */
  validate(arg: string): string | null;
  /** Vorschläge für den Parameter (z. B. WoL-Geräte, IP-Profile) */
  suggest?(): string[];
}

export interface PaletteCommand {
  /** eindeutig, z. B. "page.wifi" – gleiche id ersetzt den alten Eintrag */
  id: string;
  title: string;
  category: Category;
  /** rechts in der Zeile, z. B. "F7" oder "[ADMIN] [!]" */
  hint?: string;
  /** zusätzliche Suchwörter (werden mit durchsucht) */
  keywords?: string;
  param?: CommandParam;
  /** nur anzeigen, wenn true (z. B. abhängig vom Zustand) */
  visible?(): boolean;
  run(arg?: string): void | Promise<void>;
}

const commands = new Map<string, PaletteCommand>();
const listeners = new Set<() => void>();
let notifyScheduled = false;

/** Wird aufgerufen, wenn Befehle dazukommen (gebündelt, einmal pro Durchlauf). */
export function onCommandsChanged(fn: () => void): void {
  listeners.add(fn);
}

export function registerCommand(c: PaletteCommand): void {
  commands.set(c.id, c);
  // Seiten melden ihre Befehle nacheinander an – Listener nur einmal danach benachrichtigen
  if (!notifyScheduled) {
    notifyScheduled = true;
    queueMicrotask(() => {
      notifyScheduled = false;
      for (const fn of listeners) fn();
    });
  }
}

export function registerCommands(list: PaletteCommand[]): void {
  for (const c of list) registerCommand(c);
}

/** Befehl per ID (auch unsichtbare) – für eigene Tastenkürzel */
export function commandById(id: string): PaletteCommand | undefined {
  return commands.get(id);
}

/** Alle Befehle ohne Parameter (auch gerade unsichtbare) – Auswahl für Tastenkürzel */
export function bindableCommands(): PaletteCommand[] {
  return [...commands.values()].filter((c) => !c.param);
}

/** Alle sichtbaren Befehle in Anmelde-Reihenfolge */
export function allCommands(): PaletteCommand[] {
  return [...commands.values()].filter((c) => !c.visible || c.visible());
}
