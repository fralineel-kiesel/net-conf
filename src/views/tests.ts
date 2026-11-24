// Ansicht "Tests": Ping mit Live-Statistik und Latenz-Sparkline.
import { errorText } from "../api";
import { startCommand, type RunHandle } from "../commands";
import { explainFailure } from "../messages";
import { PingStats } from "../ping";
import { onStateChange, primaryAdapter } from "../state";
import { h, icon, replaceChildren } from "../ui/dom";
import { toast } from "../ui/toast";
import { validateTarget } from "../validate";

const SVG_NS = "http://www.w3.org/2000/svg";
const SPARK_POINTS = 60; // so viele Messwerte zeigt die Sparkline
const SPARK_W = 600;
const SPARK_H = 80;

export function createTests(): HTMLElement {
  const input = h("input", {
    class: "input",
    id: "ping-target",
    type: "text",
    value: "1.1.1.1",
    spellcheck: "false",
    autocomplete: "off",
    placeholder: "IP-Adresse oder Hostname",
  });

  // Anzahl: 4 Pakete oder unbegrenzt (ping -t)
  let unlimited = false;
  const count4 = h("button", { class: "seg active", type: "button" }, "4×");
  const countInf = h("button", { class: "seg", type: "button", title: "Läuft, bis du Stop drückst" }, "∞ bis Stop");
  const setUnlimited = (v: boolean) => {
    unlimited = v;
    count4.classList.toggle("active", !v);
    countInf.classList.toggle("active", v);
  };
  count4.addEventListener("click", () => setUnlimited(false));
  countInf.addEventListener("click", () => setUnlimited(true));

  const startBtn = h("button", { class: "btn btn-primary ping-btn" });
  const quick = h("div", { class: "quick" });

  // Statistik-Kacheln
  const tile = (label: string) => {
    const value = h("span", { class: "tile-value" }, "–");
    return { el: h("div", { class: "tile" }, h("span", { class: "tile-label" }, label), value), value };
  };
  const tSent = tile("Gesendet");
  const tRecv = tile("Empfangen");
  const tLoss = tile("Verlust");
  const tMin = tile("Min");
  const tAvg = tile("Ø");
  const tMax = tile("Max");

  // Sparkline (SVG, ohne Chart-Bibliothek)
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${SPARK_W} ${SPARK_H}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("class", "spark");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Latenzverlauf");
  const sparkLast = h("span", { class: "spark-last" });
  const sparkScale = h("span", { class: "spark-scale muted small" });

  const status = h("p", { class: "ping-status muted" }, "Bereit.");

  const view = h(
    "section",
    { class: "view", "data-view": "tests" },
    h(
      "div",
      { class: "view-header" },
      h("div", {}, h("h1", {}, "Tests"), h("p", { class: "muted" }, "Erreichbarkeit prüfen. Die Rohausgabe läuft zusätzlich in die Konsole.")),
    ),
    h(
      "article",
      { class: "card ping-card" },
      h("header", { class: "card-header" }, h("div", { class: "card-title" }, h("h2", {}, "Ping"), h("p", { class: "muted small" }, "Sendet ICMP-Echo-Anfragen und misst die Antwortzeit."))),
      h(
        "div",
        { class: "ping-form" },
        h("label", { class: "field-label", for: "ping-target" }, "Ziel"),
        h("div", { class: "ping-row" }, input, h("div", { class: "segmented", role: "group", "aria-label": "Anzahl" }, count4, countInf), startBtn),
        quick,
      ),
      h("div", { class: "tiles" }, tSent.el, tRecv.el, tLoss.el, tMin.el, tAvg.el, tMax.el),
      h("div", { class: "spark-wrap" }, svg, sparkLast, sparkScale),
      status,
    ),
  );

  // --- Zustand -------------------------------------------------------------
  let handle: RunHandle | null = null;
  let stopping = false;
  let stats = new PingStats();

  const renderButton = () => {
    if (stopping) startBtn.replaceChildren(h("span", { class: "spinner" }), "Stoppe …");
    else startBtn.replaceChildren(...(handle ? [icon("stop"), "Stop"] : [icon("play"), "Start"]));
    startBtn.disabled = stopping;
    startBtn.classList.toggle("btn-danger", !!handle);
    startBtn.classList.toggle("btn-primary", !handle);
  };

  const renderStats = () => {
    tSent.value.textContent = String(stats.sent);
    tRecv.value.textContent = String(stats.received);
    tLoss.value.textContent = stats.sent ? `${stats.lossPercent} %` : "–";
    tLoss.el.classList.toggle("bad", stats.lost > 0);
    tMin.value.textContent = stats.received ? `${stats.min} ms` : "–";
    tAvg.value.textContent = stats.avg !== null ? `${stats.avg} ms` : "–";
    tMax.value.textContent = stats.received ? `${stats.max} ms` : "–";
    renderSpark();
  };

  const renderSpark = () => {
    const data = stats.history.slice(-SPARK_POINTS);
    svg.replaceChildren();
    const last = data[data.length - 1];
    sparkLast.textContent = data.length ? (last === null ? "verloren" : `${last} ms`) : "";
    sparkLast.classList.toggle("bad", last === null);
    if (data.length === 0) {
      sparkScale.textContent = "";
      return;
    }

    const maxVal = Math.max(10, ...data.map((v) => v ?? 0)) * 1.2;
    sparkScale.textContent = `0–${Math.round(maxVal)} ms`;
    // Mindestens 10 Plätze, damit wenige Werte nicht über die ganze Breite
    // gezogen werden; bei Dauer-Ping wächst die Achse bis SPARK_POINTS.
    const slots = Math.max(10, data.length);
    const step = SPARK_W / (slots - 1);
    const x = (i: number) => i * step;
    const y = (v: number) => SPARK_H - 4 - (v / maxVal) * (SPARK_H - 8);

    // Linie in Segmente aufteilen: verlorene Pakete unterbrechen die Linie.
    let segment: string[] = [];
    const flush = () => {
      if (segment.length > 1) {
        const area = document.createElementNS(SVG_NS, "path");
        const first = segment[0].split(",")[0];
        const lastX = segment[segment.length - 1].split(",")[0];
        area.setAttribute("d", `M${first},${SPARK_H} L${segment.join(" L")} L${lastX},${SPARK_H} Z`);
        area.setAttribute("class", "spark-area");
        svg.append(area);
        const line = document.createElementNS(SVG_NS, "polyline");
        line.setAttribute("points", segment.join(" "));
        line.setAttribute("class", "spark-line");
        svg.append(line);
      } else if (segment.length === 1) {
        const [cx, cy] = segment[0].split(",");
        const dot = document.createElementNS(SVG_NS, "circle");
        dot.setAttribute("cx", cx);
        dot.setAttribute("cy", cy);
        dot.setAttribute("r", "2.5");
        dot.setAttribute("class", "spark-dot");
        svg.append(dot);
      }
      segment = [];
    };
    data.forEach((v, i) => {
      if (v === null) {
        flush();
        const mark = document.createElementNS(SVG_NS, "line");
        mark.setAttribute("x1", String(x(i)));
        mark.setAttribute("x2", String(x(i)));
        mark.setAttribute("y1", "0");
        mark.setAttribute("y2", String(SPARK_H));
        mark.setAttribute("class", "spark-lost");
        svg.append(mark);
      } else {
        segment.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
      }
    });
    flush();
  };

  // Schnellwahl: Gateway/DNS aus den Adapterdaten, plus feste Ziele.
  const renderQuick = () => {
    const a = primaryAdapter();
    const gw = a?.gateways.find((g) => g.includes(".")) ?? a?.gateways[0];
    const dns = a?.dnsServers.find((d) => d.includes(".")) ?? a?.dnsServers[0];
    const btn = (label: string, target: string | undefined, hint?: string) =>
      h(
        "button",
        {
          class: "chip",
          type: "button",
          disabled: !target,
          title: target ? `${hint ? hint + ": " : ""}${target}` : `${label}: nicht gefunden`,
          onclick: () => target && quickPing(target),
        },
        label,
        target && hint ? h("span", { class: "chip-sub" }, target) : null,
      );
    replaceChildren(
      quick,
      h("span", { class: "muted small" }, "Schnellwahl:"),
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
      toast(invalid, "error");
      status.textContent = invalid;
      input.focus();
      return;
    }

    stats = new PingStats();
    renderStats();
    status.textContent = `Ping auf ${target} läuft …`;
    const command = { kind: "ping" as const, target, count: unlimited ? null : 4 };

    try {
      handle = await startCommand(command, (line) => {
        if (stats.feed(line)) renderStats();
      });
    } catch (err) {
      const msg = errorText(err);
      toast(msg, "error");
      status.textContent = msg;
      return;
    }
    renderButton();

    const result = await handle.done;
    handle = null;
    renderButton();

    if (result.cancelled) {
      status.textContent = `Gestoppt – ${stats.sent} gesendet, ${stats.received} empfangen.`;
    } else if (stats.received === 0) {
      const msg = explainFailure(command, result.exitCode, result.lines, false);
      status.textContent = msg;
      toast(msg, "error");
    } else {
      status.textContent = `Fertig – ${stats.sent} gesendet, ${stats.received} empfangen, ${stats.lossPercent} % Verlust.`;
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
      toast(errorText(err), "error");
    } finally {
      stopping = false;
      renderButton();
    }
  }

  async function quickPing(target: string): Promise<void> {
    input.value = target;
    if (handle) await stop();
    void start();
  }

  startBtn.addEventListener("click", () => void (handle ? stop() : start()));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void (handle ? stop() : start());
  });

  onStateChange(renderQuick);
  renderQuick();
  renderButton();
  renderStats();
  return view;
}
