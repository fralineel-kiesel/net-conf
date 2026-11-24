// Einstellungen → TASTENKÜRZEL: eigene Kürzel für Befehle der Befehlspalette.
//   Liste:  KÜRZEL | BEFEHL | [ Ändern ] [ Entfernen ]
//   Neu:    Befehl wählen → [ Taste aufnehmen ] → prüfen (fest vergeben? AltGr? Konflikt?)
// Regeln und Namen: src/keys.ts, Ausführen/Aufnehmen: src/ui/shortcuts.ts.
import { checkCombo, findConflict, MAX_BINDINGS, type Keybinding } from "../keys";
import { bindableCommands, commandById, onCommandsChanged, type PaletteCommand } from "../registry";
import { onSettingsChange, settings, updateSettings } from "../settings";
import { h, replaceChildren } from "../ui/dom";
import { confirmDialog } from "../ui/modal";
import { recordCombo } from "../ui/shortcuts";
import { status } from "../ui/statusbar";
import { kvRow, panel, table, tag, tbutton } from "../ui/widgets";

const ORDER = ["SEITE", "AKTION", "TEST", "TOOL", "EINSTELLUNG"];

export function createKeysPanel(): { el: HTMLElement; render(): void } {
  const listBody = h("div", { class: "keys-list" });
  const editor = h("div", { class: "keys-editor" });
  editor.hidden = true;
  const msg = h("p", { class: "note dim keys-msg", role: "status" });
  const newBtn = tbutton("Neu", { title: "Neues Tastenkürzel anlegen", onclick: () => openEditor() });
  const p = panel(
    "TASTENKÜRZEL",
    { cls: "keys-panel", right: [newBtn] },
    listBody,
    editor,
    msg,
    kvRow(
      "Fest vergeben",
      h("span", { class: "dim" }, "F1–F10 Seiten · F5 Neu laden · Strg+K Befehlspalette · Strg +/−/0 Schriftgrösse · Strg+C/V/X/Z/A"),
    ),
    kvRow("Regeln", h("span", { class: "dim" }, "Mit Strg oder Alt kombinieren (ohne Zusatztaste nur F11–F24). Strg+Alt geht nicht (= AltGr).")),
  );

  const setMsg = (text: string, kind: "dim" | "err" | "ok" = "dim") => {
    msg.className = `note keys-msg ${kind === "err" ? "tag-err" : kind === "ok" ? "tag-ok" : "dim"}`;
    msg.textContent = text;
  };

  const label = (c: PaletteCommand | undefined, id: string) =>
    c ? h("span", {}, h("span", { class: "dim" }, `[${c.category}] `), c.title) : h("span", { class: "tag-err" }, `(unbekannter Befehl: ${id})`);

  const save = (list: Keybinding[], text: string) => {
    updateSettings({ keybindings: list });
    setMsg(text, "ok");
    status(text, "ok");
  };

  /** Kombination aufnehmen und prüfen. `index` = vorhandener Eintrag (Ändern) oder -1 (Neu). */
  async function capture(command: string, index: number): Promise<void> {
    const cmd = commandById(command);
    const combo = await recordCombo(cmd?.title ?? command);
    if (!combo) return setMsg("Aufnahme abgebrochen.");
    const err = checkCombo(combo);
    if (err) return setMsg(err, "err");
    let list = settings.keybindings.map((b) => ({ ...b }));
    const conflict = findConflict(list, combo, index);
    if (conflict) {
      const other = commandById(conflict.command)?.title ?? conflict.command;
      const ok = await confirmDialog({
        title: "Kürzel schon belegt",
        message: `${combo} ist schon „${other}“ zugeordnet.\nSoll es stattdessen „${cmd?.title ?? command}“ starten?`,
        confirmText: "Ersetzen",
      });
      if (!ok) return setMsg("Nichts geändert.");
      list = list.filter((b) => b.combo !== combo);
      index = list.findIndex((b) => b.command === command && index >= 0);
    }
    // Ein Kürzel pro Befehl: vorhandenes Kürzel dieses Befehls ersetzen
    const existing = index >= 0 ? index : list.findIndex((b) => b.command === command);
    if (existing >= 0) list[existing] = { combo, command };
    else {
      if (list.length >= MAX_BINDINGS) return setMsg(`Höchstens ${MAX_BINDINGS} Tastenkürzel.`, "err");
      list.push({ combo, command });
    }
    editor.hidden = true;
    save(list, `Tastenkürzel ${combo}: ${cmd?.title ?? command}`);
  }

  function openEditor(): void {
    const commands = bindableCommands().sort(
      (a, b) => ORDER.indexOf(a.category) - ORDER.indexOf(b.category) || a.title.localeCompare(b.title, "de"),
    );
    const select = h("select", { class: "tselect", "aria-label": "Befehl für das Tastenkürzel" });
    for (const c of commands) {
      const bound = settings.keybindings.find((b) => b.command === c.id);
      select.append(h("option", { value: c.id }, `[${c.category}] ${c.title}${bound ? `  (${bound.combo})` : ""}`));
    }
    replaceChildren(
      editor,
      kvRow("Befehl", h("span", { class: "select-wrap" }, select)),
      h(
        "div",
        { class: "panel-actions row-actions" },
        tbutton("Taste aufnehmen", { onclick: () => void capture(select.value, -1) }),
        tbutton("Abbrechen", {
          onclick: () => {
            editor.hidden = true;
            setMsg("");
          },
        }),
      ),
    );
    editor.hidden = false;
    setMsg("Befehl wählen, dann [ Taste aufnehmen ] und die Kombination drücken.");
    select.focus();
  }

  function render(): void {
    const rows = settings.keybindings.map((b, i) => ({ b, i, cmd: commandById(b.command) }));
    replaceChildren(
      listBody,
      table(
        [
          { title: "Kürzel", width: "22ch", cell: (r) => h("span", { class: "plain" }, r.b.combo) },
          { title: "Befehl", width: "minmax(0, 1fr)", cell: (r) => label(r.cmd, r.b.command) },
          {
            title: "",
            width: "auto",
            cell: (r) =>
              h(
                "span",
                { class: "row-actions" },
                tbutton("Ändern", { title: "Andere Tastenkombination aufnehmen", onclick: () => void capture(r.b.command, r.i) }),
                tbutton("Entfernen", {
                  onclick: () => {
                    const list = settings.keybindings.filter((_, k) => k !== r.i);
                    save(list, `Tastenkürzel ${r.b.combo} entfernt`);
                  },
                }),
              ),
          },
        ],
        rows,
        "noch keine eigenen Tastenkürzel – [ Neu ] klicken",
      ),
      rows.length ? h("p", { class: "dim note" }, tag(`[${rows.length}/${MAX_BINDINGS}]`, "dim"), " Kürzel stehen auch in der Befehlspalette neben dem Befehl.") : null,
    );
  }

  // Liste neu zeichnen, wenn sich die Kürzel ändern (z. B. Import, Zurücksetzen)
  let last = "";
  onSettingsChange(() => {
    const now = JSON.stringify(settings.keybindings);
    if (now !== last) {
      last = now;
      render();
    }
  });
  last = JSON.stringify(settings.keybindings);
  // Einige Befehle (Seiten, Kompaktmodus) meldet main.ts erst nach dieser Seite an
  onCommandsChanged(render);
  render();
  return { el: p.el, render };
}
