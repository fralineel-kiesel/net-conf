// Ansicht "Aktionen": ipconfig /release, /renew, /flushdns, /registerdns.
import { errorText } from "../api";
import { startCommand } from "../commands";
import { explainFailure } from "../messages";
import { onStateChange, refreshAll, setState, state } from "../state";
import type { NetCommand } from "../types";
import { askRestartAsAdmin } from "../ui/admin";
import { h } from "../ui/dom";
import { confirmDialog } from "../ui/modal";
import { status } from "../ui/statusbar";
import { kvRow, panel, prompt, tag, tbutton } from "../ui/widgets";

interface ActionDef {
  kind: "release" | "renew" | "flushDns" | "registerDns";
  title: string;
  command: string;
  description: string;
  needsAdmin: boolean;
  /** Gilt die Adapter-Auswahl für diese Aktion? */
  perAdapter: boolean;
  success: string;
}

const ACTIONS: ActionDef[] = [
  {
    kind: "release",
    title: "IP freigeben",
    command: "ipconfig /release",
    description: "Gibt die per DHCP bezogene IPv4-Adresse zurück. Die Verbindung wird getrennt.",
    needsAdmin: true,
    perAdapter: true,
    success: "IP-Adresse freigegeben",
  },
  {
    kind: "renew",
    title: "IP erneuern",
    command: "ipconfig /renew",
    description: "Fordert beim DHCP-Server eine neue IPv4-Adresse an. Kann einige Sekunden dauern.",
    needsAdmin: true,
    perAdapter: true,
    success: "IP-Adresse erneuert",
  },
  {
    kind: "flushDns",
    title: "DNS-Cache leeren",
    command: "ipconfig /flushdns",
    description: "Löscht zwischengespeicherte DNS-Einträge. Hilft, wenn Webseiten auf alte Adressen zeigen.",
    needsAdmin: false,
    perAdapter: false,
    success: "DNS-Cache geleert",
  },
  {
    kind: "registerDns",
    title: "DNS neu registrieren",
    command: "ipconfig /registerdns",
    description: "Erneuert alle DHCP-Leases und registriert den Computernamen neu im DNS.",
    needsAdmin: true,
    perAdapter: false,
    success: "DNS-Registrierung gestartet",
  },
];

// Alle Button-Beschriftungen gleich breit, damit die Klammern untereinander stehen.
const LABEL_WIDTH = Math.max(...ACTIONS.map((a) => a.title.length));

export function createActions(): HTMLElement {
  const select = h("select", { class: "tselect", id: "adapter-select", "aria-label": "Adapter" });
  let running: ActionDef["kind"] | null = null;

  const adminNote = h(
    "div",
    { class: "note" },
    tag("!", "err"),
    " Net-Conf läuft als ",
    h("span", { class: "plain" }, "[USER]"),
    ". Aktionen mit (Admin nötig) sind gesperrt.  ",
    tbutton("Als Administrator neu starten", { onclick: () => void askRestartAsAdmin() }),
  );

  const rows = ACTIONS.map((def) => {
    const btn = tbutton(def.title.padEnd(LABEL_WIDTH), { onclick: () => void runAction(def) });
    const note = h("span", { class: "action-note dim" });
    const row = h(
      "div",
      { class: "action-row" },
      btn,
      note,
      h(
        "div",
        { class: "action-info" },
        h("div", { class: "plain" }, def.command, def.perAdapter ? h("span", { class: "dim" }, " [Adapter]") : null),
        h("div", { class: "dim" }, def.description),
      ),
    );
    return { def, btn, note, row };
  });

  const p = panel(
    "IPCONFIG",
    {},
    kvRow("Adapter", h("span", { class: "select-wrap" }, select), h("span", { class: "dim" }, "gilt für freigeben/erneuern")),
    adminNote,
    h("div", { class: "action-list" }, ...rows.map((r) => r.row)),
  );

  const view = h(
    "section",
    { class: "view", "data-view": "actions" },
    prompt("ipconfig [/release | /renew | /flushdns | /registerdns]").el,
    p.el,
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
    adminNote.hidden = state.isAdmin || state.loading;
    for (const { def, btn, note } of rows) {
      const locked = def.needsAdmin && !state.isAdmin;
      btn.textContent = running === def.kind ? "läuft …".padEnd(LABEL_WIDTH) : def.title.padEnd(LABEL_WIDTH);
      // Gesperrt (kein Admin): klickbar, bietet Neustart an. Belegt: gedimmt mit [x].
      btn.disabled = state.busy && running !== def.kind;
      btn.classList.toggle("locked", locked);
      note.textContent = running === def.kind ? "" : locked ? "(Admin nötig)" : btn.disabled ? "[x]" : "";
      btn.title = locked
        ? "Dafür werden Administratorrechte benötigt. Klicken, um Net-Conf als Administrator neu zu starten."
        : btn.disabled
          ? "Gesperrt, solange ein anderer Befehl läuft"
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
    status(`${def.command} läuft …`);
    try {
      const handle = await startCommand(command);
      const result = await handle.done;
      if (result.exitCode === 0) status(def.success, "ok");
      else status(explainFailure(command, result.exitCode, result.lines, state.isAdmin), "error");
    } catch (err) {
      status(errorText(err), "error");
    } finally {
      running = null;
      setState({ busy: false });
      // Nach release/renew haben sich die Adressen geändert → Panels neu laden.
      if (def.kind === "release" || def.kind === "renew") await refreshAll();
    }
  }

  return view;
}
