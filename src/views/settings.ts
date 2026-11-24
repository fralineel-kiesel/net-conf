// Ansicht "Einstellungen": Akzentfarbe, Standard-Ping-Ziel, Konsole-Höhe, Start-Ansicht.
import { configPath, onConfigChange } from "../config";
import { ACCENTS, CONSOLE_LINES, DEFAULTS, settings, updateSettings, type Settings } from "../settings";
import { h, replaceChildren } from "../ui/dom";
import { confirmDialog } from "../ui/modal";
import { status } from "../ui/statusbar";
import { copyable, kvRow, panel, prompt, radio, tbutton } from "../ui/widgets";
import { validateTarget } from "../validate";

const START_VIEWS: { value: Settings["startView"]; label: string }[] = [
  { value: "last", label: "Zuletzt verwendet" },
  { value: "overview", label: "Übersicht" },
  { value: "actions", label: "Aktionen" },
  { value: "tests", label: "Tests" },
  { value: "tables", label: "Tabellen" },
  { value: "lan", label: "LAN" },
  { value: "wifi", label: "WLAN" },
  { value: "traffic", label: "Traffic" },
];

export function createSettings(): HTMLElement {
  const body = h("div", {});
  const p = panel("EINSTELLUNGEN", {}, body);
  const configFile = h("span", { class: "dim" }, "–");
  onConfigChange(() => replaceChildren(configFile, configPath() ? copyable(configPath()) : "–"));
  const info = panel(
    "INFO",
    {},
    kvRow("Version", `net-conf v${__APP_VERSION__}`),
    kvRow("Speicherort", "lokal im Benutzerprofil (WebView-Speicher)"),
    kvRow("Monitor / WoL", configFile),
    kvRow("Öffentliche IP", "wird nur auf Klick über ipify.org abgefragt"),
  );
  const view = h(
    "section",
    { class: "view", "data-view": "settings" },
    prompt("netconf --config").el,
    h("div", { class: "stack" }, p.el, info.el),
  );

  // Formular neu aufbauen (z. B. nach "Zurücksetzen")
  const render = () => {
    // Akzentfarbe: jede Option in ihrer eigenen Farbe beschriftet (nur Text)
    const accent = radio(
      ACCENTS.map((a) => ({ value: a.value, label: a.label })),
      settings.accent,
      (v) => {
        updateSettings({ accent: v });
        status(`Akzentfarbe: ${ACCENTS.find((a) => a.value === v)?.label}`, "ok");
      },
    );
    accent.querySelectorAll<HTMLElement>(".tcheck").forEach((b, i) => {
      b.style.setProperty("--swatch", ACCENTS[i].value);
      b.classList.add("swatch");
    });

    const pingInput = h("input", {
      class: "tinput tinput-short",
      type: "text",
      value: settings.pingTarget,
      spellcheck: "false",
      autocomplete: "off",
      "aria-label": "Standard-Ping-Ziel",
    });
    const pingMsg = h("span", { class: "dim" }, " Enter zum Speichern");
    const savePing = () => {
      const v = pingInput.value.trim();
      const err = validateTarget(v);
      if (err) {
        pingMsg.textContent = ` ${err}`;
        pingMsg.className = "tag-err";
        return;
      }
      if (v !== settings.pingTarget) {
        updateSettings({ pingTarget: v });
        status(`Standard-Ping-Ziel: ${v}`, "ok");
      }
      pingMsg.textContent = " gespeichert";
      pingMsg.className = "tag-ok";
    };
    pingInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") savePing();
    });
    pingInput.addEventListener("blur", savePing);

    const lines = radio(
      CONSOLE_LINES.map((n) => ({ value: String(n), label: `${n} Zeilen` })),
      String(settings.consoleLines),
      (v) => {
        updateSettings({ consoleLines: Number(v) });
        status(`Konsole: ${v} Zeilen`, "ok");
      },
    );

    const start = radio(START_VIEWS, settings.startView, (v) => {
      updateSettings({ startView: v });
      status(`Start-Ansicht: ${START_VIEWS.find((s) => s.value === v)?.label}`, "ok");
    });

    replaceChildren(
      body,
      kvRow("Akzentfarbe", accent, h("span", { class: "dim" }, "Grün/Rot sind für Status-Wörter reserviert.")),
      kvRow("Ping-Ziel", h("span", {}, h("span", { class: "input-wrap" }, h("span", { class: "dim" }, "> "), pingInput), pingMsg)),
      kvRow("Konsole-Höhe", lines),
      kvRow("Start-Ansicht", start),
      h(
        "div",
        { class: "panel-actions" },
        tbutton("Auf Standard zurücksetzen", {
          onclick: async () => {
            const ok = await confirmDialog({
              title: "Einstellungen zurücksetzen?",
              message: "Alle Einstellungen werden auf die Standardwerte zurückgesetzt.",
              confirmText: "Zurücksetzen",
            });
            if (!ok) return;
            updateSettings({ ...DEFAULTS });
            render();
            status("Einstellungen zurückgesetzt", "ok");
          },
        }),
      ),
    );
  };
  render();
  return view;
}
