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

export function registerCommand(c: PaletteCommand): void {
  commands.set(c.id, c);
}

export function registerCommands(list: PaletteCommand[]): void {
  for (const c of list) registerCommand(c);
}

/** Alle sichtbaren Befehle in Anmelde-Reihenfolge */
export function allCommands(): PaletteCommand[] {
  return [...commands.values()].filter((c) => !c.visible || c.visible());
}
