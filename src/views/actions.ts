// Ansicht "Aktionen": ipconfig /release, /renew, /flushdns, /registerdns.
import { errorText } from "../api";
import { startCommand } from "../commands";
import { explainFailure } from "../messages";
import { onStateChange, refreshAll, setState, state } from "../state";
import type { NetCommand } from "../types";
import { askRestartAsAdmin } from "../ui/admin";
import { h, icon, type IconName } from "../ui/dom";
import { confirmDialog } from "../ui/modal";
import { toast } from "../ui/toast";

interface ActionDef {
  kind: "release" | "renew" | "flushDns" | "registerDns";
  title: string;
  command: string;
  description: string;
  icon: IconName;
  needsAdmin: boolean;
  /** Gilt der Adapter-Filter für diese Aktion? */
  perAdapter: boolean;
  success: string;
}

const ACTIONS: ActionDef[] = [
  {
    kind: "release",
    title: "IP freigeben",
    command: "ipconfig /release",
    description: "Gibt die per DHCP bezogene IPv4-Adresse zurück. Die Verbindung wird getrennt.",
    icon: "unplug",
    needsAdmin: true,
    perAdapter: true,
    success: "IP-Adresse freigegeben",
  },
  {
    kind: "renew",
    title: "IP erneuern",
    command: "ipconfig /renew",
    description: "Fordert beim DHCP-Server eine neue IPv4-Adresse an. Kann einige Sekunden dauern.",
    icon: "refresh",
    needsAdmin: true,
    perAdapter: true,
    success: "IP-Adresse erneuert",
  },
  {
    kind: "flushDns",
    title: "DNS-Cache leeren",
    command: "ipconfig /flushdns",
    description: "Löscht zwischengespeicherte DNS-Einträge. Hilft, wenn Webseiten auf alte Adressen zeigen.",
    icon: "eraser",
    needsAdmin: false,
    perAdapter: false,
    success: "DNS-Cache geleert",
  },
  {
    kind: "registerDns",
    title: "DNS neu registrieren",
    command: "ipconfig /registerdns",
    description: "Erneuert alle DHCP-Leases und registriert den Computernamen neu im DNS.",
    icon: "upload",
    needsAdmin: true,
    perAdapter: false,
    success: "DNS-Registrierung gestartet",
  },
];

export function createActions(): HTMLElement {
  const select = h("select", { class: "select", id: "adapter-select" });
  let running: ActionDef["kind"] | null = null;

  const adminBanner = h(
    "div",
    { class: "banner" },
    icon("shield"),
    h("span", {}, "Net-Conf läuft ohne Administratorrechte. Gesperrte Aktionen sind mit einem Schloss markiert."),
    h("button", { class: "btn btn-small btn-primary", onclick: () => askRestartAsAdmin() }, "Als Administrator neu starten"),
  );

  const buttons = new Map<ActionDef["kind"], HTMLButtonElement>();
  const cards = ACTIONS.map((def) => {
    const btn = h("button", { class: "btn btn-primary action-btn", onclick: () => runAction(def) });
    buttons.set(def.kind, btn);
    return h(
      "article",
      { class: "card action-card" },
      h("div", { class: "action-icon" }, icon(def.icon)),
      h(
        "div",
        { class: "action-text" },
        h("h2", {}, def.title),
        h("code", { class: "cmd" }, def.command, def.perAdapter ? h("span", { class: "muted" }, " [Adapter]") : null),
        h("p", { class: "muted small" }, def.description),
      ),
      btn,
    );
  });

  const view = h(
    "section",
    { class: "view", "data-view": "actions" },
    h(
      "div",
      { class: "view-header" },
      h("div", {}, h("h1", {}, "Aktionen"), h("p", { class: "muted" }, "Häufige ipconfig-Befehle per Klick. Die Ausgabe erscheint in der Konsole.")),
      h(
        "div",
        { class: "view-tools" },
        h("label", { class: "field-label", for: "adapter-select" }, "Adapter (für freigeben/erneuern)"),
        select,
      ),
    ),
    adminBanner,
    h("div", { class: "action-grid" }, ...cards),
  );

  // --- Darstellung aktualisieren ------------------------------------------
  const renderSelect = () => {
    const previous = select.value;
    select.replaceChildren(h("option", { value: "" }, "Alle Adapter"));
    for (const a of state.adapters) {
      select.append(h("option", { value: a.name }, a.connected ? a.name : `${a.name} (getrennt)`));
    }
    // Auswahl beibehalten, falls der Adapter noch existiert.
    if (state.adapters.some((a) => a.name === previous)) select.value = previous;
  };

  const renderButtons = () => {
    adminBanner.hidden = state.isAdmin || state.loading;
    for (const def of ACTIONS) {
      const btn = buttons.get(def.kind)!;
      const locked = def.needsAdmin && !state.isAdmin;
      btn.replaceChildren();
      if (running === def.kind) btn.append(h("span", { class: "spinner" }), "Läuft …");
      else if (locked) btn.append(icon("lock"), "Admin nötig");
      else btn.append(icon("play"), "Ausführen");
      btn.classList.toggle("locked", locked);
      btn.disabled = state.busy;
      btn.title = locked
        ? "Dafür werden Administratorrechte benötigt. Klicken, um Net-Conf als Administrator neu zu starten."
        : def.command;
    }
  };

  onStateChange(() => {
    renderSelect();
    renderButtons();
  });
  renderSelect();
  renderButtons();

  // --- Ausführen ---------------------------------------------------------
  async function runAction(def: ActionDef): Promise<void> {
    if (state.busy) return;
    if (def.needsAdmin && !state.isAdmin) {
      return askRestartAsAdmin(`„${def.title}“ benötigt Administratorrechte.`);
    }
    const adapter = def.perAdapter && select.value ? select.value : null;

    if (def.kind === "release") {
      const ok = await confirmDialog({
        title: "IP-Adresse freigeben?",
        message:
          `Die Verbindung wird getrennt (${adapter ?? "alle Adapter"}). ` +
          "Danach hast du kein Netzwerk mehr, bis du „IP erneuern“ ausführst.",
        confirmText: "Freigeben",
        danger: true,
      });
      if (!ok) return;
    }

    const command: NetCommand =
      def.kind === "release" || def.kind === "renew" ? { kind: def.kind, adapter } : { kind: def.kind };

    running = def.kind;
    setState({ busy: true });
    try {
      const handle = await startCommand(command);
      const result = await handle.done;
      if (result.exitCode === 0) toast(def.success, "success");
      else toast(explainFailure(command, result.exitCode, result.lines, state.isAdmin), "error");
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      running = null;
      setState({ busy: false });
      // Nach release/renew haben sich die Adressen geändert → Karten neu laden.
      if (def.kind === "release" || def.kind === "renew") await refreshAll();
    }
  }

  return view;
}
