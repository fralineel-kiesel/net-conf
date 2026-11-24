// Einstiegspunkt: baut das Layout auf und verbindet alles.
import "./styles.css";
import { initBackend, isTauri } from "./api";
import { onStateChange, refreshAll, state } from "./state";
import { createConsole } from "./ui/console";
import { copyText, h, icon, prefs, type IconName } from "./ui/dom";
import { toast } from "./ui/toast";
import { createActions } from "./views/actions";
import { createOverview } from "./views/overview";
import { createTests } from "./views/tests";

type ViewId = "overview" | "actions" | "tests";

const NAV: { id: ViewId; label: string; icon: IconName }[] = [
  { id: "overview", label: "Übersicht", icon: "grid" },
  { id: "actions", label: "Aktionen", icon: "zap" },
  { id: "tests", label: "Tests", icon: "activity" },
];

function buildHeader(): HTMLElement {
  const hostBtn = h("button", { class: "host", title: "Hostname kopieren" });
  const badge = h("span", { class: "badge" });
  const reloadBtn = h(
    "button",
    { class: "btn btn-ghost reload", title: "Adapter und Status neu laden" },
    icon("refresh"),
    "Neu laden",
  );

  hostBtn.addEventListener("click", async () => {
    if (state.hostname) toast((await copyText(state.hostname)) ? "Kopiert" : "Kopieren fehlgeschlagen");
  });
  reloadBtn.addEventListener("click", () => void refreshAll());

  onStateChange(() => {
    hostBtn.textContent = state.hostname || "…";
    badge.textContent = state.isAdmin ? "Admin" : "Standard";
    badge.className = `badge ${state.isAdmin ? "badge-admin" : ""}`;
    badge.title = state.isAdmin ? "Läuft mit Administratorrechten" : "Läuft ohne Administratorrechte";
    reloadBtn.classList.toggle("spinning", state.loading);
    reloadBtn.disabled = state.loading;
  });

  return h(
    "header",
    { class: "topbar" },
    h("div", { class: "logo" }, h("span", { class: "logo-mark" }, ">_"), h("span", {}, "Net-Conf")),
    h("div", { class: "host-wrap" }, h("span", { class: "muted small" }, "Host"), hostBtn, badge),
    h("div", { class: "spacer" }),
    !isTauri ? h("span", { class: "badge badge-mock", title: "Keine Tauri-API – Testdaten" }, "Mock-Modus") : null,
    reloadBtn,
  );
}

function main(): void {
  const app = document.getElementById("app")!;

  const views: Record<ViewId, HTMLElement> = {
    overview: createOverview(),
    actions: createActions(),
    tests: createTests(),
  };

  const mainEl = h("main", { class: "main" }, views.overview, views.actions, views.tests);
  const navButtons = new Map<ViewId, HTMLButtonElement>();
  const show = (id: ViewId) => {
    for (const [key, el] of Object.entries(views)) el.hidden = key !== id;
    for (const [key, btn] of navButtons) {
      btn.classList.toggle("active", key === id);
      btn.setAttribute("aria-current", key === id ? "page" : "false");
    }
    prefs.set("view", id);
    mainEl.scrollTop = 0;
  };

  const sidebar = h(
    "nav",
    { class: "sidebar", "aria-label": "Bereiche" },
    ...NAV.map((n) => {
      const btn = h("button", { class: "nav-item", onclick: () => show(n.id) }, icon(n.icon), n.label);
      navButtons.set(n.id, btn);
      return btn;
    }),
    h("div", { class: "spacer" }),
    h("div", { class: "sidebar-footer muted small" }, `v${__APP_VERSION__}`),
  );

  app.append(
    buildHeader(),
    sidebar,
    mainEl,
    createConsole(),
  );

  const saved = prefs.get("view", "overview") as ViewId;
  show(saved in views ? saved : "overview");

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
