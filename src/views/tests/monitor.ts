// Tests → Monitor: mehrere Ziele dauerhaft anpingen (läuft im Backend weiter,
// auch wenn man die Seite wechselt). Ziele + Intervall stehen in config.json.
import { backend, errorText } from "../../api";
import { config, onConfigChange, updateConfig } from "../../config";
import { events } from "../../events";
import { ipv4Dns, ipv4Gateway } from "../../netutil";
import { LatencyScale } from "../../pingscale";
import { onStateChange, primaryAdapter } from "../../state";
import {
  MAX_MONITOR_TARGETS,
  MONITOR_INTERVALS,
  type MonitorLogEntry,
  type MonitorTarget,
  type MonitorTargetView,
  type MonitorUpdate,
} from "../../types";
import { copyText, h, replaceChildren } from "../../ui/dom";
import { createLatencyGraph, type LatencyGraph } from "../../ui/latencygraph";
import { setMonitorSummary, status } from "../../ui/statusbar";
import { choice, kvRow, panel, prompt, tag, tbutton } from "../../ui/widgets";
import { validateTarget } from "../../validate";

const MAX_LOG = 500;
/** Spalten der Statustabelle (wie table(), aber Zeilen werden aktualisiert statt neu gebaut) */
const COLUMNS = "minmax(14ch, 26ch) 8ch 7ch 7ch 8ch minmax(10ch, 1fr) 8ch 5ch";

const timeFmt = new Intl.DateTimeFormat("de-CH", { timeStyle: "medium" });
const dateTimeFmt = new Intl.DateTimeFormat("de-CH", { dateStyle: "medium", timeStyle: "medium" });

/** 28 → "28 s", 252 → "4 min 12 s", 3780 → "1 h 3 min" */
export function formatDuration(sec: number): string {
  if (sec < 60) return `${sec} s`;
  if (sec < 3600) return `${Math.floor(sec / 60)} min ${sec % 60} s`;
  return `${Math.floor(sec / 3600)} h ${Math.floor((sec % 3600) / 60)} min`;
}

const ms = (v: number | null) => (v === null ? "–" : v < 1 ? "<1 ms" : `${v} ms`);
const keyOf = (t: { name: string; host: string }) => `${t.name}\u0000${t.host}`;

interface Row {
  el: HTMLElement;
  status: HTMLElement;
  last: HTMLElement;
  avg: HTMLElement;
  loss: HTMLElement;
  since: HTMLElement;
  graph: LatencyGraph;
  scale: LatencyScale;
  lastSent: number;
  history: (number | null)[];
}

export function createMonitor(): HTMLElement {
  const heading = prompt("");
  const nameInput = h("input", {
    class: "tinput tinput-short",
    type: "text",
    spellcheck: "false",
    autocomplete: "off",
    maxlength: "40",
    placeholder: "optional, z. B. Drucker",
    "aria-label": "Name",
  });
  const hostInput = h("input", {
    class: "tinput tinput-short",
    type: "text",
    spellcheck: "false",
    autocomplete: "off",
    placeholder: "IP-Adresse oder Hostname",
    "aria-label": "Host",
  });
  const addBtn = tbutton("Hinzufügen");
  const quick = h("span", { class: "quick" });
  const intervalChoice = choice<number>(
    MONITOR_INTERVALS.map((s) => ({ value: s, label: `${s}s`, title: `alle ${s} Sekunden pingen` })),
    config().monitorIntervalSec,
    (v) => void saveTargets(config().monitorTargets, v),
  );
  const startBtn = tbutton("Start", { cls: "tbtn-wide" });
  const count = h("span", { class: "dim" });
  const runTag = h("span", {});

  const targetsPanel = panel(
    "ZIELE",
    { right: [count] },
    kvRow("Name", h("span", { class: "input-wrap" }, h("span", { class: "dim" }, "> "), nameInput)),
    kvRow("Host", h("span", { class: "input-wrap" }, h("span", { class: "dim" }, "> "), hostInput)),
    kvRow("Schnellwahl", quick),
    kvRow("Intervall", intervalChoice.el),
    h("div", { class: "panel-actions quick" }, addBtn, startBtn),
  );

  const tableBody = h("div", {});
  const head = h("div", { class: "trow thead" });
  head.style.gridTemplateColumns = COLUMNS;
  for (const [title, right] of [["ZIEL", false], ["STATUS", false], ["LETZTE", true], ["Ø", true], ["VERLUST", true], ["VERLAUF", false], ["SEIT", false], ["", false]] as const) {
    head.append(h("span", { class: right ? "cell right" : "cell" }, title));
  }
  const statusPanel = panel(
    "STATUS",
    { right: [runTag] },
    h("div", { class: "ttable monitor-table", role: "table" }, head, tableBody),
    h("p", { class: "dim wrap note" }, "DOWN erst nach 2 Zeitüberschreitungen in Folge. Pings über ICMP (nur IPv4)."),
  );

  const logBody = h("div", { class: "monitor-log", tabindex: "0", "aria-label": "Ausfall-Log" });
  const logCount = h("span", { class: "dim" });
  const logPanel = panel(
    "AUSFALL-LOG",
    {
      right: [
        logCount,
        tbutton("Log kopieren", { onclick: () => void copyLog() }),
        tbutton("Leeren", { onclick: () => void clearLog() }),
      ],
    },
    logBody,
  );

  const view = h(
    "div",
    { class: "subview" },
    heading.el,
    h("div", { class: "stack" }, targetsPanel.el, statusPanel.el, logPanel.el),
  );

  // --- Zustand ---------------------------------------------------------------
  let running = false;
  let views: MonitorTargetView[] = [];
  let log: MonitorLogEntry[] = [];
  const rows = new Map<string, Row>();

  const updateHeading = () => heading.set(`netconf monitor -i ${config().monitorIntervalSec}s  (${config().monitorTargets.length} Ziele)`);

  function makeRow(t: MonitorTarget): Row {
    const graph = createLatencyGraph({ mini: true });
    const r: Row = {
      el: h("div", { class: "trow" }),
      status: h("span", { class: "cell" }),
      last: h("span", { class: "cell right" }),
      avg: h("span", { class: "cell right" }),
      loss: h("span", { class: "cell right" }),
      since: h("span", { class: "cell" }),
      graph,
      scale: new LatencyScale(),
      lastSent: 0,
      history: [],
    };
    r.el.style.gridTemplateColumns = COLUMNS;
    const removeBtn = tbutton("x", { title: `${t.name} entfernen`, onclick: () => void removeTarget(t) });
    r.el.append(
      h(
        "span",
        { class: "cell monitor-target", title: `${t.name} – ${t.host}` },
        h("span", { class: "plain" }, t.name),
        t.name !== t.host ? h("span", { class: "dim" }, ` ${t.host}`) : null,
      ),
      r.status,
      r.last,
      r.avg,
      r.loss,
      h("span", { class: "cell" }, graph.el),
      r.since,
      h("span", { class: "cell" }, removeBtn),
    );
    return r;
  }

  /** Zeilen passend zur Zielliste aus config.json (vorhandene behalten ihren Graphen). */
  function syncRows(): void {
    const targets = config().monitorTargets;
    const wanted = new Set(targets.map(keyOf));
    for (const k of [...rows.keys()]) if (!wanted.has(k)) rows.delete(k);
    for (const t of targets) if (!rows.has(keyOf(t))) rows.set(keyOf(t), makeRow(t));
    if (targets.length === 0) {
      replaceChildren(tableBody, h("div", { class: "dim tempty" }, "noch keine Ziele – oben hinzufügen oder Schnellwahl nutzen"));
    } else {
      replaceChildren(tableBody, ...targets.map((t) => rows.get(keyOf(t))!.el));
    }
    count.textContent = `${targets.length}/${MAX_MONITOR_TARGETS}`;
    addBtn.disabled = targets.length >= MAX_MONITOR_TARGETS;
    startBtn.disabled = !running && targets.length === 0;
    updateHeading();
  }

  function renderTargets(): void {
    for (const v of views) {
      const r = rows.get(keyOf(v));
      if (!r) continue;
      replaceChildren(
        r.status,
        v.status === "up" ? tag("[UP]", "ok") : v.status === "down" ? tag("[DOWN]", "err") : tag("[ ? ]", "dim"),
      );
      r.status.title = v.error ?? (v.address ? `Adresse: ${v.address}` : "");
      r.last.textContent = ms(v.lastMs);
      r.avg.textContent = ms(v.avgMs);
      replaceChildren(r.loss, v.sent ? tag(`${v.lossPercent} %`, v.lossPercent > 0 ? "err" : "plain") : "–");
      r.since.textContent = v.sinceMs ? timeFmt.format(new Date(v.sinceMs)) : "–";
      r.since.title = v.sinceMs ? `seit ${formatDuration(Math.floor((Date.now() - v.sinceMs) / 1000))}` : "";
      // Skala nach jeder NEUEN Messung anpassen (Hysterese zählt Messungen)
      if (v.sent < r.lastSent) r.scale.reset();
      if (v.sent !== r.lastSent) {
        r.lastSent = v.sent;
        r.history = v.history;
        r.scale.update(r.history.slice(-r.graph.capacity()));
      }
      r.graph.render(r.history, r.scale.max);
    }
    replaceChildren(runTag, running ? tag("[LÄUFT]", "ok") : tag("[GESTOPPT]", "dim"));
    startBtn.textContent = running ? "Stop" : "Start";
    startBtn.disabled = !running && config().monitorTargets.length === 0;
    const down = views.filter((v) => v.status === "down").length;
    setMonitorSummary(running ? { total: views.length, down } : null);
  }

  const logText = (e: MonitorLogEntry, withDate: boolean) =>
    `${(withDate ? dateTimeFmt : timeFmt).format(new Date(e.timeMs))} ${e.host}${e.name !== e.host ? ` (${e.name})` : ""} ` +
    (e.kind === "down" ? "DOWN" : `UP${e.afterSec !== null ? ` (nach ${formatDuration(e.afterSec)})` : ""}`);

  function logLine(e: MonitorLogEntry): HTMLElement {
    return h(
      "div",
      { title: dateTimeFmt.format(new Date(e.timeMs)) },
      h("span", { class: "dim" }, timeFmt.format(new Date(e.timeMs))),
      " ",
      h("span", { class: "plain" }, e.host),
      e.name !== e.host ? h("span", { class: "dim" }, ` (${e.name})`) : null,
      " ",
      e.kind === "down" ? tag("DOWN", "err") : tag("UP", "ok"),
      e.kind === "up" && e.afterSec !== null ? h("span", { class: "dim" }, ` (nach ${formatDuration(e.afterSec)})`) : null,
    );
  }

  function renderLog(append: MonitorLogEntry[] | null): void {
    const atBottom = logBody.scrollHeight - logBody.scrollTop - logBody.clientHeight < 24;
    if (append === null || log.length === 0) {
      replaceChildren(logBody, ...(log.length ? log.map(logLine) : [h("span", { class: "dim" }, "keine Ausfälle protokolliert")]));
    } else {
      if (logBody.firstElementChild?.classList.contains("dim")) logBody.replaceChildren();
      for (const e of append) logBody.append(logLine(e));
      while (logBody.childElementCount > MAX_LOG) logBody.firstElementChild?.remove();
    }
    if (atBottom) logBody.scrollTop = logBody.scrollHeight;
    logCount.textContent = log.length ? `${log.length} Einträge` : "";
  }

  // --- Aktionen --------------------------------------------------------------
  async function saveTargets(targets: MonitorTarget[], intervalSec = config().monitorIntervalSec): Promise<boolean> {
    try {
      await updateConfig({ monitorTargets: targets, monitorIntervalSec: intervalSec });
      return true;
    } catch (err) {
      status(errorText(err), "error");
      intervalChoice.set(config().monitorIntervalSec);
      return false;
    }
  }

  async function addTarget(name: string, host: string): Promise<void> {
    const targets = config().monitorTargets;
    const err = validateTarget(host);
    if (err) {
      status(err, "error");
      return;
    }
    host = host.trim();
    if (targets.length >= MAX_MONITOR_TARGETS) return status(`Höchstens ${MAX_MONITOR_TARGETS} Ziele.`, "error");
    if (targets.some((t) => t.host.toLowerCase() === host.toLowerCase())) return status(`${host} ist schon in der Liste.`, "error");
    const t = { name: name.trim() || host, host };
    if (await saveTargets([...targets, t])) status(`Monitor-Ziel hinzugefügt: ${t.name}`, "ok");
  }

  async function removeTarget(t: MonitorTarget): Promise<void> {
    const rest = config().monitorTargets.filter((x) => keyOf(x) !== keyOf(t));
    if (await saveTargets(rest)) status(`Monitor-Ziel entfernt: ${t.name}`);
    if (rest.length === 0 && running) await toggle();
  }

  async function toggle(): Promise<void> {
    startBtn.disabled = true;
    try {
      const s = running ? await backend.monitorStop() : await backend.monitorStart();
      running = s.running;
      views = s.targets;
      status(running ? `Monitor gestartet (${views.length} Ziele, alle ${s.intervalSec} s)` : "Monitor gestoppt", running ? "ok" : "info");
    } catch (err) {
      status(errorText(err), "error");
    }
    renderTargets();
  }

  async function copyLog(): Promise<void> {
    if (log.length === 0) return status("Log ist leer");
    if (await copyText(log.map((e) => logText(e, true)).join("\r\n"))) status("kopiert: Ausfall-Log", "ok");
    else status("Kopieren fehlgeschlagen", "error");
  }

  async function clearLog(): Promise<void> {
    await backend.monitorClearLog().catch(() => undefined);
    log = [];
    renderLog(null);
    status("Ausfall-Log geleert");
  }

  const renderQuick = () => {
    const a = primaryAdapter();
    const gw = ipv4Gateway(a);
    const dns = ipv4Dns(a);
    const btn = (label: string, title: string, onclick: (() => void) | null) => {
      const b = tbutton(label, { title, onclick: onclick ?? undefined });
      b.disabled = onclick === null;
      return b;
    };
    replaceChildren(
      quick,
      btn("Gateway", gw ? `Standardgateway ${gw}` : "kein Gateway gefunden", gw ? () => void addTarget("Gateway", gw) : null),
      btn(
        "DNS-Server",
        dns.length ? dns.join(", ") : "kein IPv4-DNS-Server gefunden",
        dns.length
          ? () => {
              const missing = dns.filter((d) => !config().monitorTargets.some((t) => t.host === d));
              if (missing.length === 0) return status("Die DNS-Server sind schon in der Liste.");
              void (async () => {
                for (const [i, d] of missing.entries()) await addTarget(i === 0 ? "DNS-Server" : `DNS-Server ${i + 1}`, d);
              })();
            }
          : null,
      ),
      btn("1.1.1.1", "Cloudflare DNS", () => void addTarget("Cloudflare", "1.1.1.1")),
      btn("8.8.8.8", "Google DNS", () => void addTarget("Google DNS", "8.8.8.8")),
    );
  };

  // --- Ereignisse ------------------------------------------------------------
  addBtn.addEventListener("click", async () => {
    await addTarget(nameInput.value, hostInput.value);
    if (config().monitorTargets.some((t) => t.host === hostInput.value.trim())) {
      nameInput.value = "";
      hostInput.value = "";
    }
  });
  for (const el of [nameInput, hostInput]) {
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") addBtn.click();
    });
  }
  startBtn.addEventListener("click", () => void toggle());

  events.monitor.on((u: MonitorUpdate) => {
    running = u.running;
    views = u.targets;
    renderTargets();
    if (u.newLog.length) {
      log = [...log, ...u.newLog].slice(-MAX_LOG);
      renderLog(u.newLog);
    }
  });

  // Ziele/Intervall aus config.json → Backend (auch beim Start der App)
  onConfigChange(() => {
    intervalChoice.set(config().monitorIntervalSec);
    syncRows();
    void backend
      .monitorSet(config().monitorTargets, config().monitorIntervalSec)
      .then((s) => {
        running = s.running;
        views = s.targets;
        renderTargets();
      })
      .catch((err) => status(errorText(err), "error"));
  });

  // Nach einem Neuladen der Seite (Entwicklung) läuft das Backend evtl. schon
  void backend.monitorStatus().then((s) => {
    running = s.running;
    views = s.targets;
    log = s.log;
    renderTargets();
    renderLog(null);
  });

  onStateChange(renderQuick);
  renderQuick();
  syncRows();
  renderTargets();
  renderLog(null);
  return view;
}
