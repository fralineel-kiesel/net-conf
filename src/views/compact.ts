// Kompaktmodus: kleine Ansicht (Fenster ca. 380×260, immer im Vordergrund) mit
// dem Wichtigsten auf einen Blick. Das Fenster selbst schaltet das Backend um
// (desktop.rs); hier ist nur der Inhalt.
//
//   Hostname, primärer Adapter, IPv4, Gateway, DNS (Klick kopiert)
//   [ONLINE]/[OFFLINE] + Live-Ping zum Gateway und zu 1.1.1.1 (alle 2 s, Mini-Graph)
//
// Gepingt wird über das ICMP-Modul (icmp.rs) und NUR, solange der Kompaktmodus
// aktiv ist (activate/deactivate, setTimeout-Kette mit Generationszähler).
import { backend } from "../api";
import { ipv4Dns, ipv4Gateway, maskToPrefix } from "../netutil";
import { LatencyScale } from "../pingscale";
import { onStateChange, primaryAdapter, state } from "../state";
import { copyText, h, replaceChildren } from "../ui/dom";
import { createLatencyGraph } from "../ui/latencygraph";
import { status } from "../ui/statusbar";
import { copyable, kvRow, panel, tbutton } from "../ui/widgets";

const INTERVAL_MS = 2000;
const INTERNET = "1.1.1.1";
const MAX_HISTORY = 150;

interface PingRow {
  el: HTMLElement;
  value: HTMLElement;
  history: (number | null)[];
  scale: LatencyScale;
  render(): void;
  push(v: number | null): void;
  reset(): void;
}

function pingRow(label: string): PingRow {
  const graph = createLatencyGraph({ mini: true, label: `Latenz ${label}` });
  const value = h("span", { class: "compact-ms" }, "–");
  const row: PingRow = {
    el: h("div", { class: "compact-ping" }, h("span", { class: "dim" }, label), value, graph.el),
    value,
    history: [],
    scale: new LatencyScale(),
    render: () => {
      row.scale.update(row.history.slice(-graph.capacity()));
      graph.render(row.history, row.scale.max);
    },
    push: (v) => {
      row.history.push(v);
      if (row.history.length > MAX_HISTORY) row.history.shift();
      value.textContent = v === null ? "×" : `${v < 1 ? "<1" : Math.round(v)} ms`;
      value.className = v === null ? "compact-ms tag-err" : "compact-ms";
      row.render();
    },
    reset: () => {
      row.history = [];
      row.scale.reset();
      value.textContent = "–";
      value.className = "compact-ms";
      row.render();
    },
  };
  return row;
}

export interface CompactView {
  el: HTMLElement;
  activate(): void;
  deactivate(): void;
}

export function createCompact(): CompactView {
  const statusTag = h("span", { class: "tag tag-dim" }, "[…]");
  const body = h("div", { class: "kv-compact" });
  const gwRow = pingRow("Gateway");
  const netRow = pingRow(INTERNET);
  const copyBtn = tbutton("IPv4 kopieren", { onclick: () => void copyIpv4() });
  const p = panel("–", { right: [statusTag] }, body, gwRow.el, netRow.el, h("div", { class: "compact-actions" }, copyBtn));
  const el = h("section", { class: "view compact-view", "aria-label": "Kompaktansicht" }, p.el);

  let gateway: string | undefined;
  let lastInternet: boolean | null = null;
  let lastGateway: boolean | null = null;

  const ipv4 = () => primaryAdapter()?.ipv4[0]?.address;

  async function copyIpv4(): Promise<void> {
    const v = ipv4();
    if (!v) return status("Keine IPv4-Adresse vorhanden", "error");
    if (await copyText(v)) status(`kopiert: ${v}`, "ok");
  }

  function renderStatus(): void {
    const a = primaryAdapter();
    let text = "[…]";
    let kind: "ok" | "err" | "dim" = "dim";
    let title = "noch keine Messung";
    if (!a) {
      [text, kind, title] = ["[OFFLINE]", "err", "Kein verbundener Adapter mit Gateway"];
    } else if (lastInternet === true) {
      [text, kind, title] = ["[ONLINE]", "ok", `${INTERNET} antwortet`];
    } else if (lastInternet === false) {
      [text, kind, title] = ["[OFFLINE]", "err", lastGateway ? `Gateway antwortet, ${INTERNET} nicht` : `${INTERNET} antwortet nicht`];
    }
    statusTag.textContent = text;
    statusTag.className = `tag tag-${kind}`;
    statusTag.title = title;
  }

  function render(): void {
    const a = primaryAdapter();
    const v4 = a?.ipv4[0];
    const prefix = v4 ? maskToPrefix(v4.subnetMask) : null;
    const gw = ipv4Gateway(a);
    if (gw !== gateway) {
      gateway = gw;
      gwRow.reset(); // anderes Gateway → alter Verlauf passt nicht mehr
    }
    const dns = ipv4Dns(a);
    p.title.textContent = a ? a.name : "kein Netz";
    replaceChildren(
      body,
      kvRow("Host", state.hostname ? copyable(state.hostname) : "…"),
      kvRow("IPv4", v4 ? h("span", { class: "row-actions" }, copyable(v4.address), prefix !== null ? h("span", { class: "dim" }, `/${prefix}`) : null) : h("span", { class: "dim" }, "–")),
      kvRow("Gateway", gw ? copyable(gw) : h("span", { class: "dim" }, "–")),
      kvRow("DNS", dns.length ? h("span", { class: "row-actions" }, ...dns.slice(0, 2).map((d) => copyable(d))) : h("span", { class: "dim" }, "–")),
    );
    copyBtn.disabled = !v4;
    renderStatus();
  }

  // --- Live-Ping (nur solange aktiv) -------------------------------------------------
  let generation = 0;

  async function tick(gen: number): Promise<void> {
    const ping = (target: string | undefined) =>
      target
        ? backend
            .icmpPing(target, 1000)
            .then((r) => (r.status === "ok" ? r.rttMs : null))
            .catch(() => null)
        : Promise.resolve(undefined);
    const [g, n] = await Promise.all([ping(gateway), ping(INTERNET)]);
    if (gen !== generation) return; // inzwischen deaktiviert
    if (g !== undefined) {
      gwRow.push(g);
      lastGateway = g !== null;
    }
    if (n !== undefined) {
      netRow.push(n);
      lastInternet = n !== null;
    }
    renderStatus();
    window.setTimeout(() => {
      if (gen === generation) void tick(gen);
    }, INTERVAL_MS);
  }

  onStateChange(render);
  render();

  return {
    el,
    activate: () => {
      const gen = ++generation;
      render();
      gwRow.render();
      netRow.render();
      void tick(gen);
    },
    deactivate: () => {
      generation++; // laufende Kette endet beim nächsten Schritt
    },
  };
}

