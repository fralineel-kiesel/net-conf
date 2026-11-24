// Traffic → Live: aktuelle Download-/Upload-Rate eines Adapters, Spitze,
// Summe seit Messbeginn und zwei Block-Graphen mit ruhiger Skala.
//
// Gemessen wird 1× pro Sekunde, NUR solange die Seite "Traffic" offen ist
// (start/stop aus views/traffic.ts). Die Raten rechnet das Backend aus den
// Byte-Zählern von Windows (GetIfTable2); Zähler-Resets liefern dort `null`
// und erzeugen hier eine Lücke statt einer Riesenspitze.
import { backend, errorText } from "../../api";
import { TrafficScale } from "../../pingscale";
import { primaryAdapter } from "../../state";
import { fmtBytes, fmtDuration, fmtLink, fmtMByteRate, fmtMbit } from "../../traffic";
import type { IfTraffic, TrafficSample } from "../../types";
import { h, prefs, replaceChildren } from "../../ui/dom";
import { createLatencyGraph, type LatencyGraph } from "../../ui/latencygraph";
import { status } from "../../ui/statusbar";
import { checkbox, kvRow, panel, prompt, tag, tbutton } from "../../ui/widgets";

const INTERVAL_MS = 1000;
/** So viele Messungen merken (mehr als jeder Graph breit ist) */
const KEEP = 600;
const timeFmt = new Intl.DateTimeFormat("de-CH", { timeStyle: "medium" });
const sameId = (a: string, b: string) => a.toUpperCase() === b.toUpperCase();

/** Ein Richtungs-Panel (Download oder Upload) */
interface Direction {
  el: HTMLElement;
  cur: HTMLElement;
  peak: HTMLElement;
  sum: HTMLElement;
  graph: LatencyGraph;
  scale: TrafficScale;
  /** Mbit/s pro Messung, null = keine gültige Messung */
  history: (number | null)[];
  peakBps: number;
  sumBytes: number;
}

function direction(title: string): Direction {
  const cur = h("span", { class: "plain" }, "–");
  const peak = h("span", {}, "–");
  const sum = h("span", {}, "–");
  // Lücke statt × bei fehlender Messung; Stillstand (0) = kein Balken
  const graph = createLatencyGraph({ unit: "Mbit/s", nullMark: "none", zeroEmpty: true, label: `${title}-Verlauf` });
  const p = panel(title, {}, kvRow("Aktuell", cur), kvRow("Spitze", peak), kvRow("Summe", sum), kvRow("Verlauf", graph.el));
  return { el: p.el, cur, peak, sum, graph, scale: new TrafficScale(), history: [], peakBps: 0, sumBytes: 0 };
}

export interface LiveView {
  el: HTMLElement;
  start(): void;
  stop(): void;
}

export function createLive(): LiveView {
  let sample: TrafficSample | null = null;
  let error: string | null = null;
  let selectedId = prefs.get("trafficIf", "");
  let hideVirtual = prefs.get("trafficHideVirtual", "1") === "1";
  let startedAt = Date.now();
  let gen = 0;
  let timer: number | undefined;

  const heading = prompt("netconf traffic");
  const select = h("select", { class: "tselect", "aria-label": "Adapter" });
  const hideBox = checkbox("Virtuelle Adapter ausblenden", hideVirtual, (v) => {
    hideVirtual = v;
    prefs.set("trafficHideVirtual", v ? "1" : "0");
    buildSelect(true);
  });
  const linkEl = h("span", {}, "–");
  const sinceEl = h("span", {}, "–");
  const statusRow = kvRow("Status", h("span", {}));
  statusRow.hidden = true;
  const resetBtn = tbutton("Zurücksetzen", { title: "Spitze, Summe und Graph neu beginnen", onclick: () => resetStats() });
  const adapterPanel = panel(
    "ADAPTER",
    {},
    kvRow("Adapter", h("span", { class: "select-wrap" }, select)),
    kvRow("Anzeigen", hideBox),
    kvRow("Link", linkEl),
    kvRow("Messung", sinceEl),
    statusRow,
    h("div", { class: "panel-actions" }, resetBtn),
  );
  const down = direction("DOWNLOAD");
  const up = direction("UPLOAD");

  const el = h(
    "div",
    { class: "subview traffic" },
    heading.el,
    h(
      "div",
      { class: "stack" },
      adapterPanel.el,
      h("div", { class: "traffic-grid" }, down.el, up.el),
      h(
        "p",
        { class: "dim wrap" },
        "Gemessen wird alles, was über den Adapter läuft (alle Programme). Einheiten dezimal: 1 Mbit/s = 1 000 000 bit/s, 1 MB = 1 000 000 Byte. " +
          "Die Messung läuft nur, solange diese Seite offen ist.",
      ),
    ),
  );

  // --- Auswahl -----------------------------------------------------------------

  /** Standard: primärer Adapter, sonst der erste verbundene echte Adapter */
  function pickDefault(list: IfTraffic[]): string {
    const primary = primaryAdapter();
    const found =
      (primary && list.find((i) => sameId(i.id, primary.id))) ??
      list.find((i) => i.connected && !i.isVirtual) ??
      list.find((i) => i.connected) ??
      list[0];
    return found?.id ?? "";
  }

  let selectKey = "";
  function buildSelect(force = false): void {
    const list = sample?.interfaces ?? [];
    if (!list.some((i) => sameId(i.id, selectedId))) {
      selectedId = pickDefault(list);
      resetStats();
    }
    // Virtuelle ausblenden – ausser dem gerade gewählten
    const shown = list.filter((i) => !hideVirtual || !i.isVirtual || sameId(i.id, selectedId));
    const key = shown.map((i) => `${i.id}|${i.name}|${i.connected}`).join(";") + `#${selectedId}`;
    if (key === selectKey && !force) return; // nicht jede Sekunde neu bauen (Liste klappt sonst zu)
    selectKey = key;
    replaceChildren(
      select,
      ...(shown.length
        ? shown.map((i) =>
            h(
              "option",
              { value: i.id, selected: sameId(i.id, selectedId) },
              `${i.name}${i.isVirtual ? " [virtuell]" : ""}${i.connected ? "" : " (getrennt)"}`,
            ),
          )
        : [h("option", { value: "" }, sample ? "keine Adapter" : "lade …")]),
    );
  }

  function resetStats(): void {
    for (const d of [down, up]) {
      d.history = [];
      d.peakBps = 0;
      d.sumBytes = 0;
      d.scale.reset();
    }
    startedAt = Date.now();
    render();
  }

  // --- Messen ------------------------------------------------------------------

  function ingest(): void {
    const f = sample?.interfaces.find((i) => sameId(i.id, selectedId));
    const add = (d: Direction, bps: number | null, delta: number | null) => {
      d.history.push(bps === null ? null : bps / 1e6);
      if (d.history.length > KEEP) d.history = d.history.slice(-KEEP);
      if (bps !== null) d.peakBps = Math.max(d.peakBps, bps);
      if (delta !== null) d.sumBytes += delta;
      d.scale.update(d.history.slice(-d.graph.capacity()));
    };
    add(down, f?.rxBps ?? null, f?.rxDelta ?? null);
    add(up, f?.txBps ?? null, f?.txDelta ?? null);
  }

  function render(): void {
    const f = sample?.interfaces.find((i) => sameId(i.id, selectedId));
    heading.set(f ? `netconf traffic "${f.name}"` : "netconf traffic");
    statusRow.hidden = !error;
    if (error) replaceChildren(statusRow.querySelector(".kv-values")!, h("span", { class: "tag-err wrap" }, error));

    if (!f) linkEl.replaceChildren(h("span", { class: "dim" }, "–"));
    else if (!f.connected) linkEl.replaceChildren(tag("[GETRENNT]", "dim"));
    else if (f.rxLinkBps === null && f.txLinkBps === null) linkEl.replaceChildren(h("span", { class: "dim" }, "unbekannt"));
    else if (f.rxLinkBps === f.txLinkBps || f.txLinkBps === null) linkEl.replaceChildren(fmtLink(f.rxLinkBps ?? 0));
    else linkEl.replaceChildren(`↓ ${f.rxLinkBps === null ? "?" : fmtLink(f.rxLinkBps)} / ↑ ${fmtLink(f.txLinkBps)}`);

    sinceEl.replaceChildren(
      `seit ${timeFmt.format(startedAt)} `,
      h("span", { class: "dim" }, `(${fmtDuration((Date.now() - startedAt) / 1000)})`),
    );

    for (const d of [down, up]) {
      const last = d.history.length ? d.history[d.history.length - 1] : null;
      if (last === null) {
        d.cur.replaceChildren(h("span", { class: "dim" }, f?.connected === false ? "–" : "misst …"));
      } else {
        const bps = last * 1e6;
        d.cur.replaceChildren(fmtMbit(bps), h("span", { class: "dim" }, `  (${fmtMByteRate(bps)})`));
      }
      d.peak.replaceChildren(
        d.peakBps > 0 ? fmtMbit(d.peakBps) : "–",
        d.peakBps > 0 ? h("span", { class: "dim" }, `  (${fmtMByteRate(d.peakBps)})`) : "",
      );
      d.sum.replaceChildren(fmtBytes(d.sumBytes));
      d.graph.render(d.history, d.scale.max);
    }
  }

  async function tick(g: number): Promise<void> {
    if (g !== gen) return;
    const t0 = performance.now();
    try {
      sample = await backend.trafficPoll();
      if (error) status("Traffic-Messung läuft wieder", "ok");
      error = null;
    } catch (err) {
      sample = null;
      const msg = errorText(err);
      if (msg !== error) status(msg, "error");
      error = msg;
    }
    if (g !== gen) return;
    buildSelect();
    ingest();
    render();
    // Takt halten: Dauer des Aufrufs abziehen
    timer = window.setTimeout(() => void tick(g), Math.max(200, INTERVAL_MS - (performance.now() - t0)));
  }

  select.addEventListener("change", () => {
    selectedId = select.value;
    prefs.set("trafficIf", selectedId);
    buildSelect(true);
    resetStats(); // neuer Adapter = neuer Messbeginn
  });

  render();
  return {
    el,
    start: () => {
      const g = ++gen;
      resetStats();
      // Backend vergisst den alten Stand → die erste Messung zählt nicht (keine Durchschnittsrate über die Pause)
      void backend
        .trafficReset()
        .catch(() => undefined)
        .then(() => tick(g));
    },
    stop: () => {
      gen++;
      window.clearTimeout(timer);
    },
  };
}
