// Einstiegspunkt: baut das Layout auf und verbindet alles.
import "./styles.css";
import { initBackend, isTauri } from "./api";
import { loadConfig } from "./config";
import { onStateChange, refreshAll, state } from "./state";
import { createConsole } from "./ui/console";
import { copyText, h, logo, prefs } from "./ui/dom";
import { dialogOpen } from "./ui/modal";
import { applySettings, settings, type ViewId } from "./settings";
import { createStatusbar, status } from "./ui/statusbar";
import { tag, tbutton } from "./ui/widgets";
import { nav } from "./nav";
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

/** Kopfzeile: "net-conf @ HOSTNAME ............ [ADMIN] [ Neu laden ] (F5)" */
function buildHeader(): HTMLElement {
  const hostBtn = h("button", { class: "value host", type: "button", title: "Hostname kopieren" });
  const admin = h("span", { class: "tag" });
  const reloadBtn = tbutton("Neu laden", { title: "Adapter und Status neu laden (F5)", onclick: () => void reload() });

  hostBtn.addEventListener("click", async () => {
    if (!state.hostname) return;
    if (await copyText(state.hostname)) status(`kopiert: ${state.hostname}`, "ok");
  });

  onStateChange(() => {
    hostBtn.textContent = state.hostname || "…";
    admin.textContent = state.isAdmin ? "[ADMIN]" : "[USER]";
    admin.className = `tag ${state.isAdmin ? "tag-ok" : "tag-plain"}`;
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
    !isTauri ? tag("[MOCK]", "dim") : null,
    admin,
    reloadBtn,
    h("span", { class: "dim" }, "(F5)"),
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
  const mainEl = h("main", { class: "main" }, ...Object.values(views));
  let currentView: ViewId | null = null;

  // Seitenleiste als Textmenü: aktiver Punkt mit ">" markiert.
  const navItems = new Map<ViewId, { btn: HTMLButtonElement; marker: HTMLElement }>();
  const show = (id: ViewId) => {
    if (currentView !== id) {
      if (currentView) lifecycle[currentView]?.deactivate?.();
      lifecycle[id]?.activate();
    }
    currentView = id;
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

  app.append(buildHeader(), sidebar, mainEl, createConsole(), createStatusbar());

  // Start-Ansicht: aus den Einstellungen oder die zuletzt verwendete
  const saved = (settings.startView === "last" ? prefs.get("view", "overview") : settings.startView) as ViewId;
  show(saved in views ? saved : "overview");

  // Tastenkürzel: F1–F4, F6–F10 wechseln den Bereich, F5 lädt neu.
  // F3 in "Tests" springt zum nächsten Reiter (Ping → … → Monitor), F6 in "LAN", F8 in "Traffic" und F9 in "Werkzeuge" ebenso.
  // preventDefault, damit WebView2 nicht die Seite neu lädt (F5) oder Hilfe öffnet (F1).
  document.addEventListener(
    "keydown",
    (e) => {
      const nav = NAV.find((n) => n.key === e.key);
      if (!nav && e.key !== "F5") return;
      e.preventDefault();
      if (dialogOpen()) return;
      if (nav?.id === "tests" && currentView === "tests") tests.next();
      else if (nav?.id === "lan" && currentView === "lan") lan.next();
      else if (nav?.id === "traffic" && currentView === "traffic") traffic.next();
      else if (nav?.id === "tools" && currentView === "tools") tools.next();
      else if (nav) show(nav.id);
      else void reload();
    },
    true,
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
  });
}

main();
