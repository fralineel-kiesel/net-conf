// Einstellungen → SICHERN & ÜBERTRAGEN: Einstellungen als Text exportieren
// (Zwischenablage) und wieder importieren – z. B. auf einen zweiten PC.
// Prüfung beim Import: src/settingsdata.ts (importSettings, getestet).
import { replaceSettings, settings } from "../settings";
import { exportSettings, importSettings } from "../settingsdata";
import { copyText, h, replaceChildren } from "../ui/dom";
import { confirmDialog } from "../ui/modal";
import { status } from "../ui/statusbar";
import { kvRow, panel, tbutton } from "../ui/widgets";

export function createBackupPanel(): HTMLElement {
  const editor = h("div", {});
  editor.hidden = true;
  const msg = h("p", { class: "note dim backup-msg", role: "status" });
  const setMsg = (text: string, err = false) => {
    msg.className = `note backup-msg ${err ? "tag-err" : "dim"}`;
    msg.textContent = text;
  };

  const exportBtn = tbutton("In Zwischenablage kopieren", {
    title: "Alle Einstellungen dieser Seite als Text kopieren",
    onclick: async () => {
      const ok = await copyText(exportSettings(settings, __APP_VERSION__));
      status(ok ? "kopiert: Einstellungen (Text) – auf dem anderen PC unter „Importieren“ einfügen" : "Kopieren fehlgeschlagen", ok ? "ok" : "error");
    },
  });
  const importBtn = tbutton("Importieren …", { onclick: () => openEditor() });

  function openEditor(): void {
    const area = h("textarea", {
      class: "tarea",
      spellcheck: "false",
      placeholder: '{ "kind": "net-conf-settings", … } hier einfügen (Strg+V)',
      "aria-label": "Exportierte Einstellungen",
    });
    const apply = tbutton("Übernehmen", {
      onclick: async () => {
        const r = importSettings(area.value.trim());
        if ("error" in r) return setMsg(r.error, true);
        const ok = await confirmDialog({
          title: "Einstellungen importieren?",
          message:
            "Die aktuellen Einstellungen (Darstellung, Allgemein, Updates, Tastenkürzel) werden ersetzt." +
            (r.ignored.length ? `\n\nNicht übernommen (unbekannt oder ungültig): ${r.ignored.join(", ")}` : ""),
          confirmText: "Importieren",
        });
        if (!ok) return;
        replaceSettings(r.settings);
        editor.hidden = true;
        setMsg(r.ignored.length ? `Importiert – ${r.ignored.length} Wert(e) übersprungen.` : "Importiert.");
        status("Einstellungen importiert", "ok");
      },
    });
    const cancel = tbutton("Abbrechen", {
      onclick: () => {
        editor.hidden = true;
        setMsg("");
      },
    });
    replaceChildren(editor, area, h("div", { class: "panel-actions row-actions" }, apply, cancel));
    editor.hidden = false;
    setMsg("");
    area.focus();
  }

  return panel(
    "SICHERN & ÜBERTRAGEN",
    { cls: "backup-panel" },
    kvRow("Export", h("span", { class: "row-actions" }, exportBtn, importBtn)),
    editor,
    msg,
    h(
      "p",
      { class: "dim note" },
      "Enthält Darstellung, Allgemeines, Update-Einstellung und Tastenkürzel. IP-Profile, WoL-Geräte, Monitor-Ziele und die Tray-Einstellung stehen in config.json (Pfad unter INFO) und sind nicht dabei.",
    ),
  ).el;
}
