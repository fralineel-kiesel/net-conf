// Ansicht "Aktionen" (F2): Netzwerk-Befehle und Abläufe, gruppiert in Panels.
//
// Jede Aktion ist eine Tabellenzeile in festen Spalten:
//   [ Button ] | Status/Tags | Befehl bzw. Ablauf | Beschreibung
// Ausgeführt wird im Backend nur, was zur Aktions-ID gehört (actions.rs).
import { ACTIONS, GROUPS, type ActionDef, type ActionStep } from "../actions";
import { errorText } from "../api";
import { startAction, type RunHandle } from "../commands";
import { explainActionFailure } from "../messages";
import { onStateChange, refreshAll, setState, state } from "../state";
import { askRestartAsAdmin } from "../ui/admin";
import { h, replaceChildren, type Child } from "../ui/dom";
import { confirmDialog } from "../ui/modal";
import { status } from "../ui/statusbar";
import { kvRow, panel, prompt, tag, tbutton } from "../ui/widgets";

// Alle Buttons gleich breit (über alle Panels), damit die Spalten exakt
// untereinander stehen – Text wird mit Leerzeichen aufgefüllt.
const LABEL_WIDTH = Math.max(...ACTIONS.map((a) => a.title.length), "Abbrechen".length);

interface Row {
  def: ActionDef;
  btn: HTMLButtonElement;
  flags: HTMLElement;
  cmd: HTMLElement;
}

/** Zustand des laufenden Ablaufs */
interface Running {
  def: ActionDef;
  handle: RunHandle | null;
  step: number;
  total: number;
  /** Beschriftung pro Schritt (aus den Schrittmarkern des Backends) */
  labels: Map<number, string>;
  /** Schritte, die nur noch zur Wiederherstellung liefen */
  recovered: string[];
  /** Ausgabezeilen pro Schritt – für die Fehlererklärung zählt nur der gescheiterte */
  stepLines: Map<number, string[]>;
}

export function createActions(): HTMLElement {
  const select = h("select", { class: "tselect", id: "adapter-select", "aria-label": "Adapter" });
  let running: Running | null = null;

  const adminNote = h(
    "div",
    { class: "note" },
    tag("[!]", "err"),
    " Net-Conf läuft als ",
    h("span", { class: "plain" }, "[USER]"),
    ". Aktionen mit [ADMIN] sind gesperrt (Admin nötig).  ",
    tbutton("Als Administrator neu starten", { onclick: () => void askRestartAsAdmin() }),
  );

  const targetPanel = panel(
    "AUSWAHL",
    {},
    kvRow("Adapter", h("span", { class: "select-wrap" }, select)),
    kvRow("Gilt für", h("span", { class: "dim" }, "IP / DHCP und Adapter – alles andere wirkt systemweit")),
    kvRow(
      "Legende",
      h("span", {}, "[ADMIN] ", h("span", { class: "dim" }, "Administratorrechte nötig   "), tag("[!]", "err"),
        h("span", { class: "dim" }, " unterbricht/ändert das Netz, mit Bestätigung")),
    ),
    adminNote,
  );

  // Hinweise in einzelnen Panels
  const adapterHint = h("p", { class: "dim action-hint" }, "Wähle oben einen konkreten Adapter (nicht „Alle Adapter“).");
  const repairWarn = h(
    "p",
    { class: "action-hint" },
    tag("[!]", "err"),
    " Ändert Netzwerkeinstellungen. Nur verwenden, wenn sonst nichts hilft – danach ist ein Neustart von Windows nötig.",
  );
  const rebootNote = h(
    "p",
    { class: "action-hint" },
    tag("[NEUSTART ERFORDERLICH]", "err"),
    " Windows neu starten, damit die Änderung wirkt.",
  );
  rebootNote.hidden = true;

  // --- Zeilen aufbauen ----------------------------------------------------
  const rows: Row[] = ACTIONS.map((def) => {
    const btn = tbutton(def.title.padEnd(LABEL_WIDTH), { onclick: () => void onButton(def) });
    const flags = h("span", { class: "action-flags" });
    const cmd = h("span", { class: "action-cmd" });
    return { def, btn, flags, cmd };
  });

  const panels = GROUPS.map((g) => {
    const groupRows = rows.filter((r) => r.def.group === g.id);
    const list = h(
      "div",
      { class: "action-list" },
      ...groupRows.map((r) =>
        h("div", { class: "action-row" }, r.btn, r.flags, r.cmd, h("span", { class: "action-desc dim" }, r.def.description)),
      ),
    );
    const extra: Child[] =
      g.id === "adapter" ? [adapterHint] : g.id === "repair" ? [repairWarn] : [];
    return panel(g.title, { cls: "action-panel" }, ...extra, list, g.id === "repair" ? rebootNote : null).el;
  });

  const view = h(
    "section",
    { class: "view", "data-view": "actions" },
    prompt("ipconfig | arp | nbtstat | netsh").el,
    h("div", { class: "stack" }, targetPanel.el, ...panels),
  );
  view.style.setProperty("--btn-w", `${LABEL_WIDTH + 4}ch`); // + "[ " und " ]"

  // --- Darstellung --------------------------------------------------------
  const renderSelect = () => {
    const previous = select.value;
    select.replaceChildren(h("option", { value: "" }, "Alle Adapter"));
    for (const a of state.adapters) {
      select.append(h("option", { value: a.name }, a.connected ? a.name : `${a.name} (getrennt)`));
    }
    // Auswahl beibehalten, falls der Adapter noch existiert.
    if (state.adapters.some((a) => a.name === previous)) select.value = previous;
  };

  /** Spalte "Befehl bzw. Ablauf" */
  const renderCmd = (r: Row) => {
    const adapter = select.value;
    const steps = r.def.steps;
    if (steps.length === 1) {
      const s = steps[0];
      replaceChildren(
        r.cmd,
        h("span", { class: "plain" }, s.cmd ?? ""),
        s.perAdapter ? h("span", { class: "dim" }, ` [${adapter || "alle"}]`) : null,
      );
      r.cmd.title = s.cmd ?? "";
      return;
    }
    // Ablauf: "1 release > 2 warten > 3 renew" – Umbruch nur zwischen den Schritten
    const parts: Child[] = [];
    steps.forEach((s, i) => {
      if (i > 0) parts.push(h("span", { class: "dim" }, " > "));
      parts.push(h("span", { class: "seq-step" }, h("span", { class: "dim" }, `${i + 1} `), h("span", { class: "plain" }, s.short)));
    });
    replaceChildren(r.cmd, ...parts);
    r.cmd.title = steps.map((s, i) => `${i + 1}. ${stepText(s)}`).join("\n");
  };

  /** Button + Spalte "Status/Tags" */
  const renderRow = (r: Row) => {
    const { def, btn, flags } = r;
    const isRunning = running?.def.id === def.id;
    const locked = def.admin && !state.isAdmin;
    const noAdapter = def.adapter === "required" && !select.value;

    btn.textContent = (isRunning ? "Abbrechen" : def.title).padEnd(LABEL_WIDTH);
    // Gesperrt (kein Admin): klickbar, bietet Neustart an. Belegt/kein Adapter: gedimmt mit [x].
    btn.disabled = !isRunning && (state.busy || noAdapter);
    btn.classList.toggle("locked", locked && !isRunning);

    if (isRunning && running) {
      const progress = running.total > 1 ? ` ${Math.max(running.step, 1)}/${running.total}` : " …";
      replaceChildren(flags, tag(`läuft${progress}`, "ok"));
    } else if (locked) {
      replaceChildren(flags, h("span", { class: "dim" }, "(Admin nötig)"));
    } else if (btn.disabled) {
      replaceChildren(flags, h("span", { class: "dim" }, "[x]"));
    } else {
      replaceChildren(flags, def.admin ? tag("[ADMIN]") : null, def.admin && def.danger ? " " : null, def.danger ? tag("[!]", "err") : null);
    }

    btn.title = isRunning
      ? "Laufenden Ablauf abbrechen"
      : locked
        ? "Dafür werden Administratorrechte benötigt. Klicken, um Net-Conf als Administrator neu zu starten."
        : noAdapter
          ? "Bitte oben einen konkreten Adapter wählen"
          : btn.disabled
            ? "Gesperrt, solange eine andere Aktion läuft"
            : def.description;
  };

  const render = () => {
    adminNote.hidden = state.isAdmin || state.loading;
    adapterHint.hidden = select.value !== "";
    for (const r of rows) {
      renderCmd(r);
      renderRow(r);
    }
  };

  onStateChange(() => {
    renderSelect();
    render();
  });
  select.addEventListener("change", render);
  renderSelect();
  render();

  // --- Ausführen ----------------------------------------------------------
  async function onButton(def: ActionDef): Promise<void> {
    if (running?.def.id === def.id) return cancelRunning();
    if (state.busy) return;
    if (def.admin && !state.isAdmin) {
      return askRestartAsAdmin(`„${def.title}“ benötigt Administratorrechte.`);
    }
    const adapter = def.adapter !== "none" && select.value ? select.value : null;
    if (def.adapter === "required" && !adapter) {
      status("Bitte oben einen konkreten Adapter wählen.", "error");
      return;
    }

    if (def.danger && def.confirm) {
      const where = adapter ? `„${adapter}“` : "alle Adapter";
      const ok = await confirmDialog({
        title: def.confirm.title,
        message: def.confirm.message.replace("{adapter}", where),
        confirmText: def.confirm.confirmText,
        danger: true,
      });
      if (!ok) return;
    }

    const run: Running = { def, handle: null, step: 0, total: def.steps.length, labels: new Map(), recovered: [], stepLines: new Map() };
    running = run;
    setState({ busy: true });
    status(`${def.title} läuft …`);
    let needsReboot = false;
    try {
      run.handle = await startAction(def.id, adapter, {
        onLine: (line) => {
          const n = Math.max(run.step, 1);
          run.stepLines.set(n, [...(run.stepLines.get(n) ?? []), line]);
        },
        onStep: (e) => {
          run.step = e.index;
          run.labels.set(e.index, e.label);
          if (e.recovery) run.recovered.push(e.label);
          render();
          status(`[${e.index}/${e.total}] ${e.label} …`);
        },
      });
      const result = await run.handle.done;
      const recoveredText = run.recovered.length
        ? ` Zur Wiederherstellung wurde „${run.recovered.join("“, „")}“ trotzdem ausgeführt.`
        : "";

      if (result.cancelled) {
        status(`„${def.title}“ abgebrochen.${recoveredText}`, "error");
      } else if (result.exitCode === 0 && result.failedStep === null) {
        status(def.success, "ok");
        needsReboot = def.reboot;
      } else {
        const n = result.failedStep ?? 1;
        const lines = run.total > 1 ? (run.stepLines.get(n) ?? []) : result.lines;
        const reason = result.error ?? explainActionFailure(def, adapter, result.exitCode, lines, state.isAdmin);
        const where =
          run.total > 1 ? `Schritt ${n}/${run.total} (${run.labels.get(n) ?? def.steps[n - 1]?.short}) ist fehlgeschlagen` : `„${def.title}“ ist fehlgeschlagen`;
        status(`${where}: ${reason}${recoveredText}`, "error");
      }
    } catch (err) {
      status(errorText(err), "error");
    } finally {
      running = null;
      setState({ busy: false });
      // Neue IP, neuer Status → Panels neu laden. Nach einem Adapter-Neustart
      // braucht DHCP ein paar Sekunden, darum später noch einmal.
      if (def.changesIp) {
        await refreshAll();
        if (def.id === "adapterRestart") setTimeout(() => void refreshAll(), 5000);
      }
    }
    if (needsReboot) await showRebootNotice(def);
  }

  async function cancelRunning(): Promise<void> {
    const r = running;
    if (!r?.handle) return;
    status(`„${r.def.title}“ wird abgebrochen …`);
    try {
      await r.handle.cancel();
    } catch (err) {
      status(errorText(err), "error");
    }
  }

  async function showRebootNotice(def: ActionDef): Promise<void> {
    rebootNote.hidden = false;
    await confirmDialog({
      title: "Neustart erforderlich",
      message: `„${def.title}“ war erfolgreich. Starte Windows neu, damit die Änderung wirkt. Bis dahin kann das Netzwerk eingeschränkt sein.`,
      confirmText: "Verstanden",
      infoOnly: true,
    });
  }

  return view;
}

function stepText(s: ActionStep): string {
  return s.waitMs ? `warten (${s.waitMs / 1000} s)` : (s.cmd ?? s.short);
}
