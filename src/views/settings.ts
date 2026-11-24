// Ansicht "Einstellungen" (F10):
//   DARSTELLUNG  Theme (mit Vorschau), Schriftart (mit Vorschau), Akzentfarbe (nur Theme Cyan), Schriftgrösse
//   ALLGEMEIN    Standard-Ping-Ziel, Konsole-Höhe, Start-Ansicht
//   FENSTER      In den Tray minimieren, Mit Windows starten
//   UPDATES      Beim Start prüfen, Jetzt prüfen
//   INFO         Version, Speicherorte
import { backend, errorText } from "../api";
import { config, configPath, onConfigChange, updateConfig } from "../config";
import {
  ACCENTS,
  CONSOLE_LINES,
  DEFAULTS,
  FONT_DEFAULT,
  FONT_MAX,
  FONT_MIN,
  FONTS,
  activeFont,
  onSettingsChange,
  setFont,
  setFontSize,
  setTheme,
  settings,
  THEMES,
  updateSettings,
  type Settings,
} from "../settings";
import { ensureFont } from "../fonts";
import { fontById, type FontDef, type Theme } from "../themes";
import type { AutostartStatus } from "../types";
import { formatUnix, h, replaceChildren } from "../ui/dom";
import { confirmDialog } from "../ui/modal";
import { status } from "../ui/statusbar";
import { checkForUpdates, lastCheck } from "../ui/updates";
import { checkbox, copyable, kvRow, panel, prompt, radio, tag, tbutton } from "../ui/widgets";
import { validateTarget } from "../validate";
import { registerCommand, registerCommands } from "../registry";
import { nav } from "../nav";

const START_VIEWS: { value: Settings["startView"]; label: string }[] = [
  { value: "last", label: "Zuletzt verwendet" },
  { value: "overview", label: "Übersicht" },
  { value: "actions", label: "Aktionen" },
  { value: "tests", label: "Tests" },
  { value: "tables", label: "Tabellen" },
  { value: "lan", label: "LAN" },
  { value: "wifi", label: "WLAN" },
  { value: "traffic", label: "Traffic" },
  { value: "tools", label: "Werkzeuge" },
];

/** Schrift auf ein Vorschau-Element anwenden (Grösse wie in der App, inkl. `scale`). */
function applyPreviewFont(el: HTMLElement, f: FontDef): void {
  ensureFont(f.id); // eingebettete Schrift erst jetzt laden
  el.style.fontFamily = f.family;
  el.style.fontSize = `${Math.round(settings.fontSize * f.scale)}px`;
}

/** Vorschauzeile in den Farben und der Schrift eines Themes (unabhängig vom aktiven Theme). */
function themePreview(t: Theme): HTMLElement {
  const c = t.colors;
  const span = (text: string, color = c.text, bg?: string) => {
    const s = h("span", {}, text);
    s.style.color = color; // CSSOM – mit der CSP erlaubt
    if (bg) s.style.background = bg;
    return s;
  };
  const el = h(
    "span",
    { class: "theme-preview", "aria-hidden": "true" },
    span(" net-conf ", c.bright),
    span("IPv4 ", c.dim),
    span("192.168.1.42 ", c.text),
    span("[ONLINE]", c.ok),
    span(" "),
    span("[WARNUNG]", c.warn),
    span(" "),
    span("[OFFLINE]", c.err),
    span(" "),
    span("[ Aktiv ]", c.bg, c.accent),
    span(" "),
  );
  el.style.background = c.bg;
  el.style.borderColor = c.line;
  applyPreviewFont(el, fontById(t.font));
  return el;
}

export function createSettings(): HTMLElement {
  const lookBody = h("div", {});
  const generalBody = h("div", {});
  const windowBody = h("div", {});
  const updateBody = h("div", {});
  const look = panel("DARSTELLUNG", {}, lookBody);
  const general = panel("ALLGEMEIN", {}, generalBody);
  const windowPanel = panel("FENSTER", {}, windowBody);
  const updates = panel("UPDATES", {}, updateBody);
  const configFile = h("span", { class: "dim" }, "–");
  onConfigChange(() => replaceChildren(configFile, configPath() ? copyable(configPath()) : "–"));
  const info = panel(
    "INFO",
    {},
    kvRow("Version", `net-conf v${__APP_VERSION__}`),
    kvRow("Darstellung", "lokal im Benutzerprofil (WebView-Speicher)"),
    kvRow("Daten", configFile, h("span", { class: "dim" }, "Monitor, WoL-Geräte, IP-Profile, Fenster")),
    kvRow("Öffentliche IP", "wird nur auf Klick über ipify.org abgefragt"),
    kvRow("Tasten", h("span", {}, "Strg+K Befehlspalette · Strg +/−/0 Schriftgrösse")),
  );
  const resetBtn = tbutton("Auf Standard zurücksetzen", {
    onclick: async () => {
      const ok = await confirmDialog({
        title: "Einstellungen zurücksetzen?",
        message: "Darstellung, Ping-Ziel, Konsole und Start-Ansicht werden auf die Standardwerte zurückgesetzt.",
        confirmText: "Zurücksetzen",
      });
      if (!ok) return;
      updateSettings({ ...DEFAULTS });
      renderLook();
      renderGeneral();
      renderUpdates();
      status("Einstellungen zurückgesetzt", "ok");
    },
  });
  const view = h(
    "section",
    { class: "view", "data-view": "settings" },
    prompt("netconf --config").el,
    h("div", { class: "stack" }, look.el, general.el, windowPanel.el, updates.el, info.el, h("div", {}, resetBtn)),
  );

  // --- DARSTELLUNG --------------------------------------------------------------
  const fontValue = h("span", { class: "plain" });
  const renderFont = () => {
    fontValue.textContent = `${settings.fontSize} px`.padStart(5);
  };
  const fontRow = h(
    "span",
    { class: "row-actions" },
    tbutton("−", { title: "Kleiner (Strg −)", onclick: () => changeFont(settings.fontSize - 1) }),
    fontValue,
    tbutton("+", { title: "Grösser (Strg +)", onclick: () => changeFont(settings.fontSize + 1) }),
    tbutton("Standard", { title: `${FONT_DEFAULT} px (Strg 0)`, onclick: () => changeFont(FONT_DEFAULT) }),
    h("span", { class: "dim" }, ` ${FONT_MIN}–${FONT_MAX} px · Strg +/−/0`),
  );
  const changeFont = (px: number) => {
    const v = setFontSize(px);
    status(`Schriftgrösse: ${v} px`, "ok");
  };

  function renderLook(): void {
    // Theme-Liste: (*) Name   Vorschauzeile   Beschreibung
    const themeRows = THEMES.map((t) => {
      const active = t.id === settings.theme;
      const btn = h(
        "button",
        { class: "tcheck theme-pick", type: "button", role: "radio", "aria-checked": String(active), onclick: () => pickTheme(t) },
        h("span", { class: "mark" }, active ? "(*)" : "( )"),
        " ",
        t.label.padEnd(11),
      );
      return h(
        "div",
        { class: "theme-row" },
        btn,
        themePreview(t),
        h("span", { class: "dim theme-desc" }, `${t.description} · ${fontById(t.font).label}`),
      );
    });

    // Schriftart: (*) vom Theme  |  ( ) Name  Vorschau in genau dieser Schrift  Herkunft
    const fontOption = (value: FontDef["id"] | "theme", label: string, f: FontDef, desc: string) => {
      const active = settings.font === value;
      const btn = h(
        "button",
        { class: "tcheck font-pick", type: "button", role: "radio", "aria-checked": String(active), onclick: () => pickFont(value) },
        h("span", { class: "mark" }, active ? "(*)" : "( )"),
        " ",
        label.padEnd(16),
      );
      const sample = h("span", { class: "font-sample", "aria-hidden": "true" }, "ipconfig /all 0O 1lI [ONLINE] äöü");
      applyPreviewFont(sample, f);
      return h("div", { class: "theme-row" }, btn, sample, h("span", { class: "dim theme-desc" }, desc));
    };
    const themeFont = fontById(THEMES.find((t) => t.id === settings.theme)!.font);
    const fontRows = [
      fontOption("theme", "vom Theme", themeFont, `jetzt: ${themeFont.label}`),
      ...FONTS.map((f) =>
        fontOption(f.id, f.label, f, `${f.description} · ${f.source === "windows" ? "Windows" : "eingebettet"}${f.scale !== 1 ? ` · ×${f.scale}` : ""}`),
      ),
    ];

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
    const accentAllowed = settings.theme === "cyan";
    renderFont();
    replaceChildren(
      lookBody,
      kvRow("Theme", h("div", { class: "theme-list", role: "radiogroup", "aria-label": "Theme" }, ...themeRows)),
      kvRow(
        "Schriftart",
        h("div", { class: "theme-list", role: "radiogroup", "aria-label": "Schriftart" }, ...fontRows),
        h("span", { class: "dim" }, "Nur Monospace (Terminal-Raster). Eingebettete Schriften sind in der App enthalten – offline, Lizenz SIL OFL."),
      ),
      kvRow(
        "Akzentfarbe",
        accentAllowed ? accent : h("span", { class: "dim" }, "im Theme festgelegt (wählbar beim Theme Cyan)"),
        accentAllowed ? h("span", { class: "dim" }, "Grün/Rot sind für Status-Wörter reserviert.") : null,
      ),
      kvRow("Schriftgrösse", fontRow),
    );
  }

  function pickTheme(t: Theme): void {
    setTheme(t.id);
    renderLook();
    status(`Theme: ${t.label}${settings.font === "theme" ? ` (Schrift ${fontById(t.font).label})` : ""}`, "ok");
  }

  function pickFont(id: FontDef["id"] | "theme"): void {
    setFont(id);
    renderLook();
    status(`Schriftart: ${id === "theme" ? `vom Theme (${activeFont().label})` : activeFont().label}`, "ok");
  }

  // --- ALLGEMEIN ------------------------------------------------------------------
  function renderGeneral(): void {
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
      generalBody,
      kvRow("Ping-Ziel", h("span", {}, h("span", { class: "input-wrap" }, h("span", { class: "dim" }, "> "), pingInput), pingMsg)),
      kvRow("Konsole-Höhe", lines),
      kvRow("Start-Ansicht", start),
    );
  }

  // --- FENSTER ----------------------------------------------------------------------
  let autostart: AutostartStatus | null = null;
  function renderWindow(): void {
    const tray = checkbox("Beim Schliessen in den Tray minimieren", config().closeToTray, (v) => {
      updateConfig({ closeToTray: v })
        .then(() => status(v ? "Schliessen minimiert jetzt in den Tray" : "Schliessen beendet Net-Conf wieder", "ok"))
        .catch((e) => {
          status(errorText(e), "error");
          renderWindow();
        });
    });
    const auto = checkbox("Mit Windows starten", autostart?.enabled ?? false, (v) => {
      backend
        .autostartSet(v)
        .then((s) => {
          autostart = s;
          renderWindow();
          status(v ? "Autostart eingerichtet (startet minimiert im Tray)" : "Autostart entfernt", "ok");
        })
        .catch((e) => {
          status(errorText(e), "error");
          renderWindow();
        });
    });
    if (autostart && !autostart.supported) auto.disabled = true;
    replaceChildren(
      windowBody,
      kvRow("Schliessen", tray, h("span", { class: "dim" }, "Beenden dann über das Tray-Menü (Rechtsklick auf das Symbol).")),
      kvRow(
        "Autostart",
        auto,
        h("span", { class: "dim" }, "Startet minimiert im Tray – immer OHNE Adminrechte ([USER])."),
        autostart?.otherPath
          ? h("span", { class: "tag-warn" }, "Ein Autostart-Eintrag zeigt auf eine andere net-conf.exe – einschalten ersetzt ihn.")
          : null,
      ),
      kvRow("Kompaktmodus", h("span", { class: "dim" }, "[ Kompakt ] in der Kopfzeile, im Tray-Menü oder per Strg+K")),
    );
  }

  // --- UPDATES ------------------------------------------------------------------------
  const updateMsg = h("span", { class: "dim" });
  function renderUpdates(): void {
    const auto = checkbox("Beim Start nach Updates suchen", settings.updateCheck, (v) => {
      updateSettings({ updateCheck: v });
      status(v ? "Update-Prüfung beim Start: ein (max. 1× pro Tag)" : "Update-Prüfung beim Start: aus", "ok");
    });
    const checkBtn = tbutton("Jetzt prüfen", {
      onclick: async () => {
        checkBtn.disabled = true;
        updateMsg.className = "dim";
        updateMsg.textContent = "prüfe …";
        const r = await checkForUpdates(true);
        updateMsg.className = r.ok ? "plain" : "tag-err";
        updateMsg.textContent = r.text;
        status(r.text, r.ok ? "ok" : "error");
        checkBtn.disabled = false;
        renderUpdates();
      },
    });
    const last = lastCheck();
    replaceChildren(
      updateBody,
      kvRow("Automatisch", auto, h("span", { class: "dim" }, "höchstens 1× pro 24 h, Fehler werden dabei still ignoriert")),
      kvRow("Manuell", h("span", { class: "row-actions" }, checkBtn), updateMsg),
      kvRow("Zuletzt", last ? formatUnix(Math.floor(last / 1000)) : h("span", { class: "dim" }, "noch nie")),
      kvRow("Quelle", h("span", {}, "GitHub-Releases (api.github.com) ", tag("[NUR HINWEIS]", "dim")), h("span", { class: "dim" }, "Kein automatischer Download – der Klick öffnet nur die Release-Seite.")),
    );
  }

  // Schriftgrösse kann sich auch per Tastatur/Befehlspalette ändern
  // Theme, Schriftart oder -grösse können sich auch per Tastatur/Befehlspalette ändern
  let lookKey = "";
  onSettingsChange(() => {
    const key = `${settings.theme}|${settings.font}|${settings.fontSize}`;
    if (key !== lookKey) {
      lookKey = key;
      renderLook();
    }
  });
  onConfigChange(renderWindow);

  // Befehlspalette: Themes, Schriftgrösse, Update-Prüfung
  registerCommands(
    THEMES.map((t) => ({
      id: `setting.theme.${t.id}`,
      title: `Theme: ${t.label}`,
      category: "EINSTELLUNG" as const,
      hint: t.description,
      keywords: "farbe darstellung aussehen",
      run: () => pickTheme(t),
    })),
  );
  registerCommands([
    {
      id: "setting.font.theme",
      title: "Schriftart: vom Theme",
      category: "EINSTELLUNG",
      keywords: "font schrift standard",
      run: () => pickFont("theme"),
    },
    ...FONTS.map((f) => ({
      id: `setting.font.${f.id}`,
      title: `Schriftart: ${f.label}`,
      category: "EINSTELLUNG" as const,
      hint: f.description,
      keywords: "font schrift",
      run: () => pickFont(f.id),
    })),
    { id: "setting.font.up", title: "Schrift grösser", category: "EINSTELLUNG", hint: "Strg +", keywords: "zoom schriftgrösse", run: () => changeFont(settings.fontSize + 1) },
    { id: "setting.font.down", title: "Schrift kleiner", category: "EINSTELLUNG", hint: "Strg −", keywords: "zoom schriftgrösse", run: () => changeFont(settings.fontSize - 1) },
    { id: "setting.font.reset", title: `Schrift Standard (${FONT_DEFAULT} px)`, category: "EINSTELLUNG", hint: "Strg 0", keywords: "zoom schriftgrösse zurücksetzen", run: () => changeFont(FONT_DEFAULT) },
  ]);
  registerCommand({
    id: "setting.update",
    title: "Nach Updates suchen",
    category: "EINSTELLUNG",
    keywords: "version release neu",
    run: async () => {
      nav.show("settings");
      status("Suche nach Updates …");
      const r = await checkForUpdates(true);
      status(r.text, r.ok ? "ok" : "error");
      renderUpdates();
    },
  });

  renderLook();
  renderGeneral();
  renderWindow();
  renderUpdates();
  void backend
    .autostartGet()
    .then((s) => {
      autostart = s;
      renderWindow();
    })
    .catch(() => {});
  return view;
}
