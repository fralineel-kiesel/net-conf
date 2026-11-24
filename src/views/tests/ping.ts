// Tests → Ping: Live-Statistik und Latenz-Graph aus Blockzeichen.
import { errorText } from "../../api";
import { startCommand, type RunHandle } from "../../commands";
import { explainFailure } from "../../messages";
import { PingStats } from "../../ping";
import { onStateChange, primaryAdapter } from "../../state";
import { blockGraph } from "../../ui/blockgraph";
import { h, replaceChildren } from "../../ui/dom";
import { status } from "../../ui/statusbar";
import { kvRow, panel, prompt, radio, tag, tbutton } from "../../ui/widgets";
import { onSettingsChange, settings } from "../../settings";
import { validateTarget } from "../../validate";

const GRAPH_POINTS = 60; // so viele Messwerte zeigt der Graph
const GRAPH_ROWS = 4; // Höhe in Textzeilen

export function createPing(): HTMLElement {
  const heading = prompt(`ping -n 4 ${settings.pingTarget}`);
  const input = h("input", {
    class: "tinput",
    id: "ping-target",
    type: "text",
    value: settings.pingTarget,
    spellcheck: "false",
    autocomplete: "off",
    placeholder: "IP-Adresse oder Hostname",
    "aria-label": "Ziel",
  });

  // Anzahl: 4 Pakete oder unbegrenzt (ping -t)
  let unlimited = false;
  const countRadio = radio(
    [
      { value: "4", label: "4 Pakete" },
      { value: "inf", label: "bis Stop", title: "Läuft, bis du Stop drückst (ping -t)" },
    ],
    "4",
    (v) => {
      unlimited = v === "inf";
      updateHeading();
    },
  );

  const startBtn = tbutton("Start", { cls: "tbtn-wide" });
  const quick = h("span", { class: "quick" });

  // Statistik als Textzeilen
  const packets = h("span", { class: "plain" }, "–");
  const latency = h("span", { class: "plain" }, "–");
  const statusLine = h("span", { class: "dim" }, "bereit");
  const graph = h("div", { class: "graph", "aria-label": "Latenzverlauf" });

  const pingPanel = panel(
    "PING",
    {},
    kvRow("Ziel", h("span", { class: "input-wrap" }, h("span", { class: "dim" }, "> "), input)),
    kvRow("Anzahl", countRadio),
    kvRow("Schnellwahl", quick),
    h("div", { class: "panel-actions" }, startBtn),
  );
  const statsPanel = panel(
    "STATISTIK",
    {},
    kvRow("Pakete", packets),
    kvRow("Latenz", latency),
    kvRow("Status", statusLine),
    kvRow(`Verlauf (${GRAPH_POINTS})`, graph),
  );

  const view = h("div", { class: "subview" }, heading.el, h("div", { class: "stack" }, pingPanel.el, statsPanel.el));

  // --- Zustand -------------------------------------------------------------
  let handle: RunHandle | null = null;
  let stopping = false;
  let stats = new PingStats();

  function updateHeading(): void {
    const target = input.value.trim() || "<ziel>";
    heading.set(`ping ${unlimited ? "-t" : "-n 4"} ${target}`);
  }

  const setStatus = (text: string, kind: "plain" | "ok" | "err" | "dim" = "plain") => {
    statusLine.textContent = text;
    statusLine.className = `tag-${kind}`;
  };

  const renderButton = () => {
    startBtn.textContent = stopping ? "stoppe …" : handle ? "Stop" : "Start";
    startBtn.disabled = stopping;
  };

  const renderStats = () => {
    if (stats.sent === 0) {
      packets.replaceChildren("–");
      latency.replaceChildren("–");
    } else {
      packets.replaceChildren(
        `gesendet ${stats.sent}, empfangen ${stats.received}, verloren `,
        tag(`${stats.lost} (${stats.lossPercent} %)`, stats.lost > 0 ? "err" : "plain"),
      );
      latency.replaceChildren(
        stats.received ? `min ${stats.min} ms, avg ${stats.avg} ms, max ${stats.max} ms` : "–",
      );
    }
    renderGraph();
  };

  const renderGraph = () => {
    const data = stats.history.slice(-GRAPH_POINTS);
    if (data.length === 0) {
      replaceChildren(graph, h("span", { class: "dim" }, "–"));
      return;
    }
    const cells = blockGraph(data, GRAPH_ROWS);
    const valid = data.filter((v): v is number => v !== null);
    // Achsenbeschriftung rechts: oben max, unten min
    const labels = valid.length ? [`${Math.max(...valid)} ms`, ...Array(GRAPH_ROWS - 2).fill(""), `${Math.min(...valid)} ms`] : [];
    const lines = cells.map((row, i) => {
      const line = h("div", { class: "graph-row" });
      // Aufeinanderfolgende Zeichen gleicher Art zu einem Textstück zusammenfassen
      let buf = "";
      let lostRun = false;
      const flush = () => {
        if (buf) line.append(lostRun ? tag(buf, "err") : buf);
        buf = "";
      };
      for (const c of row) {
        if (c.lost !== lostRun) {
          flush();
          lostRun = c.lost;
        }
        buf += c.ch;
      }
      flush();
      line.append(h("span", { class: "dim" }, " ".repeat(GRAPH_POINTS - row.length + 1) + (labels[i] ?? "")));
      return line;
    });
    replaceChildren(graph, ...lines);
  };

  // Schnellwahl: Gateway/DNS aus den Adapterdaten, plus feste Ziele.
  const renderQuick = () => {
    const a = primaryAdapter();
    const gw = a?.gateways.find((g) => g.includes(".")) ?? a?.gateways[0];
    const dns = a?.dnsServers.find((d) => d.includes(".")) ?? a?.dnsServers[0];
    const btn = (label: string, target: string | undefined, hint?: string) => {
      const b = tbutton(label, {
        title: target ? `${hint ? hint + ": " : ""}${target}` : `${label}: nicht gefunden`,
        onclick: () => target && void quickPing(target),
      });
      b.disabled = !target;
      return b;
    };
    replaceChildren(
      quick,
      btn("Gateway", gw, "Standardgateway"),
      btn("DNS-Server", dns, "DNS-Server"),
      btn("1.1.1.1", "1.1.1.1"),
      btn("8.8.8.8", "8.8.8.8"),
      btn("google.com", "google.com"),
    );
  };

  // --- Ablauf --------------------------------------------------------------
  async function start(): Promise<void> {
    if (handle) return;
    const target = input.value.trim();
    const invalid = validateTarget(target);
    if (invalid) {
      setStatus(invalid, "err");
      status(invalid, "error");
      input.focus();
      return;
    }

    stats = new PingStats();
    renderStats();
    setStatus(`läuft auf ${target} …`, "ok");
    status(`ping ${target} läuft …`);
    const command = { kind: "ping" as const, target, count: unlimited ? null : 4 };

    try {
      handle = await startCommand(command, (line) => {
        if (stats.feed(line)) renderStats();
      });
    } catch (err) {
      const msg = errorText(err);
      setStatus(msg, "err");
      status(msg, "error");
      return;
    }
    renderButton();

    const result = await handle.done;
    handle = null;
    renderButton();

    if (result.cancelled) {
      setStatus(`gestoppt – ${stats.sent} gesendet, ${stats.received} empfangen`);
      status("Ping gestoppt");
    } else if (stats.received === 0) {
      const msg = explainFailure(command, result.exitCode, result.lines, false);
      setStatus(msg, "err");
      status(msg, "error");
    } else {
      setStatus(`fertig – ${stats.lossPercent} % Verlust`, stats.lost > 0 ? "err" : "ok");
      status(`Ping ${target}: ${stats.received}/${stats.sent} Antworten`, stats.lost > 0 ? "error" : "ok");
    }
  }

  async function stop(): Promise<void> {
    if (!handle || stopping) return;
    const h0 = handle;
    stopping = true;
    renderButton();
    try {
      await h0.cancel();
      await h0.done; // warten, bis der Prozess wirklich beendet ist
    } catch (err) {
      status(errorText(err), "error");
    } finally {
      stopping = false;
      renderButton();
    }
  }

  async function quickPing(target: string): Promise<void> {
    input.value = target;
    updateHeading();
    if (handle) await stop();
    void start();
  }

  startBtn.addEventListener("click", () => void (handle ? stop() : start()));
  input.addEventListener("input", updateHeading);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void (handle ? stop() : start());
  });

  // Neues Standard-Ziel aus den Einstellungen übernehmen, solange nichts läuft
  let lastDefault = settings.pingTarget;
  onSettingsChange(() => {
    if (settings.pingTarget === lastDefault) return;
    if (!handle && input.value.trim() === lastDefault) {
      input.value = settings.pingTarget;
      updateHeading();
    }
    lastDefault = settings.pingTarget;
  });

  onStateChange(renderQuick);
  renderQuick();
  renderButton();
  renderStats();
  updateHeading();
  return view;
}
