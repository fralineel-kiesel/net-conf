// Einstiegspunkt: baut das Layout auf und verbindet alles.
import "./styles.css";
import { initBackend, isTauri } from "./api";
import { onStateChange, refreshAll, state } from "./state";
import { createConsole } from "./ui/console";
import { copyText, h, logo, prefs } from "./ui/dom";
import { dialogOpen } from "./ui/modal";
import { createStatusbar, status } from "./ui/statusbar";
import { tag, tbutton } from "./ui/widgets";
import { createActions } from "./views/actions";
import { createOverview } from "./views/overview";
import { createTests } from "./views/tests";

type ViewId = "overview" | "actions" | "tests";

const NAV: { id: ViewId; label: string; key: string }[] = [
  { id: "overview", label: "Übersicht", key: "F1" },
  { id: "actions", label: "Aktionen", key: "F2" },
  { id: "tests", label: "Tests", key: "F3" },
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
  const app = document.getElementById("app")!;

  const views: Record<ViewId, HTMLElement> = {
    overview: createOverview(),
    actions: createActions(),
    tests: createTests(),
  };
  const mainEl = h("main", { class: "main" }, views.overview, views.actions, views.tests);

  // Seitenleiste als Textmenü: aktiver Punkt mit ">" markiert.
  const navItems = new Map<ViewId, { btn: HTMLButtonElement; marker: HTMLElement }>();
  const show = (id: ViewId) => {
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

  const sidebar = h(
    "nav",
    { class: "sidebar", "aria-label": "Bereiche" },
    h("div", { class: "menu-title" }, "MENÜ"),
    ...NAV.map((n) => {
      const marker = h("span", { class: "marker" }, " ");
      const btn = h(
        "button",
        { class: "menu-item", type: "button", onclick: () => show(n.id) },
        marker,
        h("span", { class: "menu-label" }, n.label),
        h("span", { class: "menu-key" }, n.key),
      );
      navItems.set(n.id, { btn, marker });
      return btn;
    }),
  );

  app.append(buildHeader(), sidebar, mainEl, createConsole(), createStatusbar());

  const saved = prefs.get("view", "overview") as ViewId;
  show(saved in views ? saved : "overview");

  // Tastenkürzel: F1–F3 wechseln den Bereich, F5 lädt neu.
  // preventDefault, damit WebView2 nicht die Seite neu lädt (F5) oder Hilfe öffnet (F1).
  document.addEventListener(
    "keydown",
    (e) => {
      const nav = NAV.find((n) => n.key === e.key);
      if (!nav && e.key !== "F5") return;
      e.preventDefault();
      if (dialogOpen()) return;
      if (nav) show(nav.id);
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

  void initBackend().then(refreshAll);
}

main();
