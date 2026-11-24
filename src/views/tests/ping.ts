// Tests → Ping: Live-Statistik und ruhiger Latenz-Graph (fester Nullpunkt, Skala mit Hysterese).
import { errorText } from "../../api";
import { startCommand, type RunHandle } from "../../commands";
import { explainFailure } from "../../messages";
import { PingStats } from "../../ping";
import { LatencyScale } from "../../pingscale";
import { onStateChange, primaryAdapter } from "../../state";
import { h, replaceChildren } from "../../ui/dom";
import { createLatencyGraph } from "../../ui/latencygraph";
import { status } from "../../ui/statusbar";
import { choice, kvRow, panel, prompt, tag, tbutton } from "../../ui/widgets";
import { nav } from "../../nav";
import { onSettingsChange, settings } from "../../settings";
import { PING_COUNTS } from "../../types";
import { validateTarget } from "../../validate";

/** "inf" = unbegrenzt (ping -t, bis Stop) */
type Count = (typeof PING_COUNTS)[number] | "inf";
const DEFAULT_COUNT: Count = 4;

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

  // Anzahl: 2 … 32 Pakete (ping -n) oder unbegrenzt (ping -t). Das Backend
  // prüft die Zahl noch einmal gegen dieselbe Liste.
  let count: Count = DEFAULT_COUNT;
  const countChoice = choice<Count>(
    [
      ...PING_COUNTS.map((n) => ({ value: n as Count, label: String(n), title: `${n} Pakete (ping -n ${n})` })),
      { value: "inf", label: "∞", title: "Unbegrenzt, bis du Stop drückst (ping -t)" },
    ],
    count,
    (v) => {
      count = v;
      updateHeading();
    },
  );

  const startBtn = tbutton("Start", { cls: "tbtn-wide" });
  const quick = h("span", { class: "quick" });

  // Statistik als Textzeilen
  const packets = h("span", { class: "plain" }, "–");
  const latency = h("span", { class: "plain" }, "–");
  const statusLine = h("span", { class: "dim" }, "bereit");
  const graph = createLatencyGraph();
  const scale = new LatencyScale();

  const pingPanel = panel(
    "PING",
    {},
    kvRow("Ziel", h("span", { class: "input-wrap" }, h("span", { class: "dim" }, "> "), input)),
    kvRow("Anzahl", countChoice.el),
    kvRow("Schnellwahl", quick),
    h("div", { class: "panel-actions" }, startBtn),
  );
  const statsPanel = panel(
    "STATISTIK",
    {},
    kvRow("Pakete", packets),
    kvRow("Latenz", latency),
    kvRow("Status", statusLine),
    kvRow("Verlauf", graph.el),
  );

  const view = h("div", { class: "subview" }, heading.el, h("div", { class: "stack" }, pingPanel.el, statsPanel.el));

  // --- Zustand -------------------------------------------------------------
  let handle: RunHandle | null = null;
  let stopping = false;
  let stats = new PingStats();

  function updateHeading(): void {
    const target = input.value.trim() || "<ziel>";
    heading.set(`ping ${count === "inf" ? "-t" : `-n ${count}`} ${target}`);
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

  // Statistik bleibt exakt (ungeglättet); nur die Skala des Graphen ist "ruhig".
  const renderGraph = () => graph.render(stats.history, scale.max);

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
    scale.reset();
    renderStats();
    setStatus(`läuft auf ${target} …`, "ok");
    status(`ping ${target} läuft …`);
    const command = { kind: "ping" as const, target, count: count === "inf" ? null : count };

    try {
      handle = await startCommand(command, (line) => {
        if (stats.feed(line)) {
          // Skala nach jeder Messung anpassen – mit den Werten, die gerade sichtbar sind
          scale.update(stats.history.slice(-graph.capacity()));
          renderStats();
        }
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
      const msg = explainFailure(command, result.exitCode, result.lines);
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
    renderGraph(); // Akzentfarbe könnte sich geändert haben
  });

  // Andere Ansichten (LAN-Scanner) können hierher springen und ein Ziel anpingen
  nav.startPing = (target) => void quickPing(target);

  onStateChange(renderQuick);
  renderQuick();
  renderButton();
  renderStats();
  updateHeading();
  return view;
}
