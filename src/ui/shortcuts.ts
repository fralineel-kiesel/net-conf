// Eigene Tastenkürzel: ausführen (globaler Tasten-Listener) und aufnehmen (Dialog).
// Die Logik (Namen, Regeln, Konflikte) steht in src/keys.ts.
//
// Sicherheit: Ein Kürzel startet nur einen Befehl der Registry – genau wie die
// Befehlspalette. Aktionen laufen also mit Admin-Hinweis und Bestätigungsdialog.
// Solange ein Dialog oder die Palette offen ist, reagieren Kürzel nicht.
import { errorText } from "../api";
import { comboFromEvent } from "../keys";
import { commandById } from "../registry";
import { settings } from "../settings";
import { h } from "./dom";
import { dialogOpen } from "./modal";
import { paletteOpen } from "./palette";
import { status } from "./statusbar";
import { panel, tbutton } from "./widgets";

let recording = false;

/** Läuft gerade eine Aufnahme? (dann keine anderen Tastenkürzel) */
export function isRecording(): boolean {
  return recording;
}

/** Tastenkürzel → Befehl (für die Anzeige in der Befehlspalette) */
export function comboForCommand(id: string): string | undefined {
  return settings.keybindings.find((b) => b.command === id)?.combo;
}

/** Einmal beim Start: Tastendrücke mit den eigenen Kürzeln vergleichen. */
export function initShortcuts(): void {
  document.addEventListener(
    "keydown",
    (e) => {
      if (recording || dialogOpen() || paletteOpen() || !settings.keybindings.length) return;
      const combo = comboFromEvent(e);
      if (!combo) return;
      const binding = settings.keybindings.find((b) => b.combo === combo);
      if (!binding) return;
      e.preventDefault();
      e.stopPropagation();
      const cmd = commandById(binding.command);
      if (!cmd || cmd.param) {
        status(`${combo}: Befehl „${binding.command}“ gibt es nicht (mehr) – unter Einstellungen → Tastenkürzel anpassen.`, "error");
        return;
      }
      if (cmd.visible && !cmd.visible()) {
        status(`${combo}: „${cmd.title}“ ist gerade nicht verfügbar.`, "error");
        return;
      }
      status(`${combo}: ${cmd.title}`);
      try {
        void Promise.resolve(cmd.run()).catch((err) => status(errorText(err), "error"));
      } catch (err) {
        status(errorText(err), "error");
      }
    },
    true,
  );
}

/**
 * Dialog „Taste drücken …“. Liefert die Kombination ("Strg+Umschalt+D") oder
 * null bei Esc/Abbrechen. Geprüft wird danach (keys.checkCombo) vom Aufrufer.
 */
export function recordCombo(commandTitle: string): Promise<string | null> {
  return new Promise((resolve) => {
    recording = true;
    const preview = h("span", { class: "plain" }, "…");
    const done = (combo: string | null) => {
      recording = false;
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("keyup", onKeyUp, true);
      backdrop.remove();
      resolve(combo);
    };
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey) return done(null);
      const combo = comboFromEvent(e);
      if (combo) done(combo);
      else {
        // nur Zusatztasten gedrückt – Zwischenstand zeigen
        const mods = [e.ctrlKey && "Strg", e.altKey && "Alt", e.shiftKey && "Umschalt"].filter(Boolean);
        preview.textContent = mods.length ? `${mods.join("+")}+…` : "…";
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.altKey && !e.shiftKey) preview.textContent = "…";
    };
    const cancel = tbutton("Abbrechen", { onclick: () => done(null) });
    const box = panel(
      "TASTENKÜRZEL AUFNEHMEN",
      { cls: "dialog recording" },
      h("p", {}, "Befehl: ", h("span", { class: "plain" }, commandTitle)),
      h("p", {}, "Drücke jetzt die Tastenkombination, z. B. Strg+Umschalt+D oder Alt+P.\nEsc = abbrechen."),
      h("p", {}, "> ", preview, h("span", { class: "cursor", "aria-hidden": "true" }, "█")),
      h("div", { class: "dialog-actions" }, cancel),
    );
    box.el.setAttribute("role", "dialog");
    box.el.setAttribute("aria-modal", "true");
    const backdrop = h("div", { class: "dialog-backdrop" }, box.el);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("keyup", onKeyUp, true);
    document.body.append(backdrop);
    // Fokus weg vom auslösenden Button – sonst würde Leertaste/Enter ihn erneut klicken
    (document.activeElement as HTMLElement | null)?.blur?.();
  });
}
