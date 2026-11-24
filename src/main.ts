// Einstiegspunkt: baut das Layout auf und verbindet alles.
import "./styles.css";
import { backend, errorText, initBackend, isTauri } from "./api";
import { events } from "./events";
import { createCompact } from "./views/compact";
import { loadConfig } from "./config";
import { onStateChange, refreshAll, state } from "./state";
import { createConsole } from "./ui/console";
import { copyText, h, logo, prefs } from "./ui/dom";
import { dialogOpen } from "./ui/modal";
import { applySettings, FONT_DEFAULT, setFontSize, settings, type ViewId } from "./settings";
import { initUpdates } from "./ui/updates";
import { initShortcuts, isRecording } from "./ui/shortcuts";
import { createStatusbar, status } from "./ui/statusbar";
import { tbutton } from "./ui/widgets";
import { nav } from "./nav";
import { registerCommand, registerCommands } from "./registry";
import { paletteOpen, togglePalette } from "./ui/palette";
import { createActions } from "./views/actions";
import { createLan } from "./views/lan";
import { createOverview } from "./views/overview";
import { createSettings } from "./views/settings";
import { createTables } from "./views/tables";
import { createTests } from "./views/tests";
import { createTools } from "./views/tools";
import { createTraffic } from "./views/traffic";
import { createWifi } from "./views/wifi";

const NAV: { id: ViewId; label: string; key: string }[] = [
  { id: "overview", label: "Übersicht", key: "F1" },
  { id: "actions", label: "Aktionen", key: "F2" },
  { id: "tests", label: "Tests", key: "F3" },
  { id: "tables", label: "Tabellen", key: "F4" },
  { id: "lan", label: "LAN", key: "F6" },
  { id: "wifi", label: "WLAN", key: "F7" },
  { id: "traffic", label: "Traffic", key: "F8" },
  { id: "tools", label: "Werkzeuge", key: "F9" },
  { id: "settings", label: "Einstellungen", key: "F10" },
];

/** Kopfzeile: "net-conf @ HOSTNAME ............ [ADMIN] [ Kompakt ] [ Neu laden ] (F5)" */
function buildHeader(compactBtn: HTMLButtonElement): HTMLElement {
  const hostBtn = h("button", { class: "value host", type: "button", title: "Hostname kopieren" });
  const admin = h("span", { class: "tag hide-compact" });
  const reloadBtn = tbutton("Neu laden", { title: "Adapter und Status neu laden (F5)", onclick: () => void reload(), cls: "hide-compact" });

  hostBtn.addEventListener("click", async () => {
    if (!state.hostname) return;
    if (await copyText(state.hostname)) status(`kopiert: ${state.hostname}`, "ok");
  });

  onStateChange(() => {
    hostBtn.textContent = state.hostname || "…";
    admin.textContent = state.isAdmin ? "[ADMIN]" : "[USER]";
    admin.className = `tag hide-compact ${state.isAdmin ? "tag-ok" : "tag-plain"}`;
    admin.title = state.isAdmin ? "Läuft mit Administratorrechten" : "Läuft ohne Administratorrechte";
    reloadBtn.textContent = state.loading ? "lädt …" : "Neu laden";
    reloadBtn.disabled = state.loading;
  });

  return h(
    "header",
    { class: "topbar" },
    logo(),
    h("span", { class: "who" }, h("span", { class: "bright" }, "net-conf"), h("span", { class: "dim" }, " @ "), hostBtn),
    h("span", { class: "spacer" }),
    !isTauri ? h("span", { class: "tag tag-dim hide-compact" }, "[MOCK]") : null,
    admin,
    compactBtn,
    reloadBtn,
    h("span", { class: "dim hide-compact" }, "(F5)"),
  );
}

async function reload(): Promise<void> {
  await refreshAll();
  status(state.error ? "Neu laden fehlgeschlagen" : "neu geladen", state.error ? "error" : "info");
}

function main(): void {
  applySettings(); // Akzentfarbe usw. vor dem ersten Zeichnen setzen
  const app = document.getElementById("app")!;

  const tests = createTests();
  const tables = createTables();
  const lan = createLan();
  const wifi = createWifi();
  const traffic = createTraffic();
  const tools = createTools();
  const views: Record<ViewId, HTMLElement> = {
    overview: createOverview(),
    actions: createActions(),
    tests: tests.el,
    tables: tables.el,
    lan: lan.el,
    wifi: wifi.el,
    traffic: traffic.el,
    tools: tools.el,
    settings: createSettings(),
  };
  // Seiten mit Timern: activate() beim Öffnen, deactivate() beim Verlassen –
  // so laufen Messungen (WLAN alle 2 s, Traffic jede Sekunde) nur, solange man hinschaut.
  const lifecycle: Partial<Record<ViewId, { activate(): void; deactivate?(): void }>> = {
    tables, // Tabellen erst beim ersten Öffnen laden
    wifi,
    traffic,
  };
  const compact = createCompact();
  const mainEl = h("main", { class: "main" }, ...Object.values(views), compact.el);
  let currentView: ViewId | null = null;

  // --- Kompaktmodus: Backend schaltet das Fenster, hier nur das Layout ----------------
  let compactOn = false;
  const compactBtn = tbutton("Kompakt", { title: "Kompaktmodus: kleines Fenster, immer im Vordergrund" });
  const setCompactUi = (on: boolean) => {
    if (on === compactOn) return;
    compactOn = on;
    document.body.classList.toggle("compact", on);
    // Im Browser (Mock) lässt sich das Fenster nicht verkleinern – Kasten in Zielgrösse zeigen
    if (!isTauri) document.body.classList.toggle("compact-sim", on);
    compactBtn.textContent = on ? "Normal" : "Kompakt";
    compactBtn.title = on ? "Zurück zur normalen Ansicht (vorherige Grösse und Position)" : "Kompaktmodus: kleines Fenster, immer im Vordergrund";
    // Timer der verdeckten Seite pausieren bzw. wieder starten
    if (on) {
      if (currentView) lifecycle[currentView]?.deactivate?.();
      compact.activate();
    } else {
      compact.deactivate();
      if (currentView) lifecycle[currentView]?.activate();
    }
  };
  const setCompact = (on: boolean) =>
    backend
      .setCompact(on)
      .then(setCompactUi)
      .catch((e) => status(errorText(e), "error"));
  compactBtn.addEventListener("click", () => void setCompact(!compactOn));
  events.compact.on(setCompactUi); // auch vom Tray-Menü

  // Seitenleiste als Textmenü: aktiver Punkt mit ">" markiert.
  const navItems = new Map<ViewId, { btn: HTMLButtonElement; marker: HTMLElement }>();
  const show = (id: ViewId) => {
    // Im Kompaktmodus heisst „Seite zeigen“: zurück zur normalen Ansicht.
    // Die Timer startet dann setCompactUi(false) für die neue Seite.
    const leavingCompact = compactOn;
    if (currentView !== id && !leavingCompact) {
      if (currentView) lifecycle[currentView]?.deactivate?.();
      lifecycle[id]?.activate();
    }
    currentView = id;
    if (leavingCompact) void setCompact(false);
    for (const [key, el] of Object.entries(views)) el.hidden = key !== id;
    for (const [key, { btn, marker }] of navItems) {
      const active = key === id;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-current", active ? "page" : "false");
      marker.textContent = active ? ">" : " ";
    }
    prefs.set("view", id);
    mainEl.scrollTop = 0;
  };
  nav.show = show;

  // Befehlspalette: alle Seiten + Neu laden
  registerCommands(
    NAV.map((n) => ({
      id: `page.${n.id}`,
      title: `Gehe zu ${n.label}`,
      category: "SEITE" as const,
      hint: n.key,
      run: () => show(n.id),
    })),
  );
  registerCommand({
    id: "app.compact",
    title: "Kompaktmodus ein/aus",
    category: "EINSTELLUNG",
    keywords: "klein fenster vordergrund mini normal",
    run: () => setCompact(!compactOn),
  });
  registerCommand({
    id: "app.reload",
    title: "Neu laden",
    category: "AKTION",
    hint: "F5",
    keywords: "aktualisieren refresh adapter",
    run: () => reload(),
  });

  const sidebar = h(
    "nav",
    { class: "sidebar", "aria-label": "Bereiche" },
    h("div", { class: "menu-title" }, "MENÜ"),
    ...NAV.map((n) => {
      // Trennlinie vor "Einstellungen"
      const sep = n.id === "settings" ? h("div", { class: "menu-sep", "aria-hidden": "true" }) : null;
      const marker = h("span", { class: "marker" }, " ");
      const btn = h(
        "button",
        { class: "menu-item", type: "button", onclick: () => show(n.id) },
        marker,
        h("span", { class: "menu-label" }, n.label),
        h("span", { class: "menu-key" }, n.key),
      );
      navItems.set(n.id, { btn, marker });
      return sep ? h("div", {}, sep, btn) : btn;
    }),
  );

  app.append(buildHeader(compactBtn), sidebar, mainEl, createConsole(), createStatusbar());

  // Start-Ansicht: aus den Einstellungen oder die zuletzt verwendete
  const saved = (settings.startView === "last" ? prefs.get("view", "overview") : settings.startView) as ViewId;
  show(saved in views ? saved : "overview");

  // Tastenkürzel: F1–F4, F6–F10 wechseln den Bereich, F5 lädt neu.
  // F3 in "Tests" springt zum nächsten Reiter (Ping → … → Monitor), F6 in "LAN", F8 in "Traffic" und F9 in "Werkzeuge" ebenso.
  // preventDefault, damit WebView2 nicht die Seite neu lädt (F5) oder Hilfe öffnet (F1).
  document.addEventListener(
    "keydown",
    (e) => {
      // Strg+K: Befehlspalette (nicht, solange ein Dialog offen ist)
      if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (!dialogOpen()) togglePalette();
        return;
      }
      const nav = NAV.find((n) => n.key === e.key);
      if (!nav && e.key !== "F5") return;
      e.preventDefault();
      if (dialogOpen() || paletteOpen()) return;
      if (nav?.id === "tests" && currentView === "tests") tests.next();
      else if (nav?.id === "lan" && currentView === "lan") lan.next();
      else if (nav?.id === "traffic" && currentView === "traffic") traffic.next();
      else if (nav?.id === "tools" && currentView === "tools") tools.next();
      else if (nav) show(nav.id);
      else void reload();
    },
    true,
  );

  // Schriftgrösse: Strg + / Strg − / Strg 0 (wie im Browser, aber über die App-Einstellung –
  // das Zoomen des WebViews wird verhindert, sonst würden Canvas-Graphen unscharf).
  document.addEventListener(
    "keydown",
    (e) => {
      if (!e.ctrlKey || e.altKey || e.metaKey || isRecording()) return;
      let next: number | null = null;
      if (e.key === "+" || e.key === "=" || e.code === "NumpadAdd") next = settings.fontSize + 1;
      else if (e.key === "-" || e.code === "NumpadSubtract") next = settings.fontSize - 1;
      else if (e.key === "0" || e.code === "Numpad0") next = FONT_DEFAULT;
      if (next === null) return;
      e.preventDefault();
      status(`Schriftgrösse: ${setFontSize(next)} px`, "ok");
    },
    true,
  );
  initShortcuts(); // eigene Tastenkürzel (Einstellungen → Tastenkürzel)

  // Strg + Mausrad würde den WebView zoomen
  document.addEventListener(
    "wheel",
    (e) => {
      if (e.ctrlKey) e.preventDefault();
    },
    { passive: false },
  );

  // In der fertigen App das Browser-Kontextmenü (Zurück/Neu laden/Untersuchen)
  // ausblenden – ausser in Eingabefeldern und der Konsole (Kopieren).
  if (isTauri && import.meta.env.PROD) {
    document.addEventListener("contextmenu", (e) => {
      const t = e.target as HTMLElement;
      if (!t.closest("input, textarea, .console-body")) e.preventDefault();
    });
  }

  void initBackend().then(async () => {
    // config.json (Monitor-Ziele, WoL-Geräte) laden – ein Hinweis (z. B. kaputte Datei) kommt in die Statusleiste
    const [notice] = await Promise.all([loadConfig(), refreshAll()]);
    if (notice) status(notice, "error");
    initUpdates(); // gemerkten Update-Hinweis zeigen, ggf. still prüfen (max. 1× pro 24 h)
    // Falls der WebView neu geladen wurde, während das Fenster kompakt war
    setCompactUi(await backend.getCompact().catch(() => false));
  });
}

main();
