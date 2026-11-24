// Tests → Traceroute: tracert.exe über den Runner, Hops live als Tabelle.
import { errorText } from "../../api";
import { startCommand, type RunHandle } from "../../commands";
import { explainFailure } from "../../messages";
import { primaryAdapter, onStateChange } from "../../state";
import { hopAvg, parseHop, type Hop } from "../../tracert";
import { h, replaceChildren } from "../../ui/dom";
import { status } from "../../ui/statusbar";
import { bar, checkbox, copyable, kvRow, panel, prompt, table, tag, tbutton } from "../../ui/widgets";
import { validateTarget } from "../../validate";

export function createTracert(): HTMLElement {
  const heading = prompt("");
  const input = h("input", {
    class: "tinput",
    type: "text",
    value: "1.1.1.1",
    spellcheck: "false",
    autocomplete: "off",
    placeholder: "IP-Adresse oder Hostname",
    "aria-label": "Ziel",
  });
  let resolve = false;
  const resolveBox = checkbox("Hostnamen der Hops auflösen (deutlich langsamer)", false, (v) => {
    resolve = v;
    updateHeading();
  });
  const startBtn = tbutton("Start");
  const quick = h("span", { class: "quick" });
  const statusLine = h("span", { class: "dim" }, "bereit");
  const hopsEl = h("div", {});

  const formPanel = panel(
    "TRACEROUTE",
    {},
    kvRow("Ziel", h("span", { class: "input-wrap" }, h("span", { class: "dim" }, "> "), input)),
    kvRow("Optionen", resolveBox),
    kvRow("Schnellwahl", quick),
    h("div", { class: "panel-actions" }, startBtn),
  );
  const routePanel = panel("ROUTE", {}, kvRow("Status", statusLine), h("div", { class: "spacer-line" }), hopsEl);

  const view = h("div", { class: "subview" }, heading.el, h("div", { class: "stack" }, formPanel.el, routePanel.el));

  let handle: RunHandle | null = null;
  let hops: Hop[] = [];

  function updateHeading(): void {
    heading.set(`tracert -h 30 -w 1000 ${resolve ? "" : "-d "}${input.value.trim() || "<ziel>"}`);
  }

  const setStatus = (text: string, kind: "plain" | "ok" | "err" | "dim" = "plain") => {
    statusLine.textContent = text;
    statusLine.className = `tag-${kind}`;
  };

  const renderHops = () => {
    // Balkenlänge relativ zum langsamsten Hop
    const maxAvg = Math.max(1, ...hops.map((x) => hopAvg(x) ?? 0));
    const fmt = (r: number | null) => (r === null ? tag("*", "dim") : r === 0 ? "<1 ms" : `${r} ms`);
    replaceChildren(
      hopsEl,
      table(
        [
          { title: "Hop", width: "4ch", cell: (x: Hop) => String(x.hop), align: "right" },
          { title: "1", width: "7ch", cell: (x) => fmt(x.rtts[0]), align: "right" },
          { title: "2", width: "7ch", cell: (x) => fmt(x.rtts[1]), align: "right" },
          { title: "3", width: "7ch", cell: (x) => fmt(x.rtts[2]), align: "right" },
          {
            title: "Latenz",
            width: "13ch",
            cell: (x) => {
              const avg = hopAvg(x);
              return avg === null ? "" : bar(avg / maxAvg, 10);
            },
          },
          {
            title: "Adresse",
            width: "minmax(0, 1fr)",
            cell: (x) => {
              if (!x.ip) return tag("keine Antwort", "dim");
              return h(
                "span",
                {},
                copyable(x.ip),
                x.name ? h("span", { class: "dim" }, `  ${x.name}`) : null,
                // z. B. "meldet: Zielnetz nicht erreichbar" – Text von Windows
                x.rest.includes(":") && !x.name && x.rest !== x.ip
                  ? h("span", { class: "tag-err" }, `  ${x.rest.slice(x.ip.length).trim()}`)
                  : null,
              );
            },
          },
        ],
        hops,
        handle ? "warte auf ersten Hop …" : "noch keine Route ermittelt",
      ),
    );
  };

  const renderButton = () => {
    startBtn.textContent = handle ? "Stop" : "Start";
  };

  const renderQuick = () => {
    const a = primaryAdapter();
    const gw = a?.gateways.find((g) => g.includes("."));
    const btn = (label: string, target?: string) => {
      const b = tbutton(label, { title: target ?? `${label}: nicht gefunden`, onclick: () => target && void quickStart(target) });
      b.disabled = !target;
      return b;
    };
    replaceChildren(quick, btn("Gateway", gw), btn("1.1.1.1", "1.1.1.1"), btn("8.8.8.8", "8.8.8.8"), btn("google.com", "google.com"));
  };

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
    hops = [];
    const command = { kind: "tracert" as const, target, resolve };
    setStatus(`läuft auf ${target} … (max. 30 Hops)`, "ok");
    status(`tracert ${target} läuft …`);
    try {
      handle = await startCommand(command, (line) => {
        const hop = parseHop(line);
        if (hop) {
          hops.push(hop);
          renderHops();
        }
      });
    } catch (err) {
      const msg = errorText(err);
      setStatus(msg, "err");
      status(msg, "error");
      return;
    }
    renderButton();
    renderHops();
    const result = await handle.done;
    handle = null;
    renderButton();
    renderHops();

    const last = hops[hops.length - 1];
    if (result.cancelled) {
      setStatus(`gestoppt nach ${hops.length} Hops`);
      status("Traceroute gestoppt");
    } else if (hops.length === 0) {
      const msg = explainFailure(command, result.exitCode, result.lines, false);
      setStatus(msg, "err");
      status(msg, "error");
    } else {
      const reached = last.ip !== null && (last.ip === target || last.name === target || result.exitCode === 0);
      setStatus(`fertig – ${hops.length} Hops`, reached ? "ok" : "err");
      status(`Traceroute ${target}: ${hops.length} Hops`, "ok");
    }
  }

  async function stop(): Promise<void> {
    const h0 = handle;
    if (!h0) return;
    try {
      await h0.cancel();
      await h0.done;
    } catch (err) {
      status(errorText(err), "error");
    }
  }

  async function quickStart(target: string): Promise<void> {
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

  onStateChange(renderQuick);
  renderQuick();
  renderButton();
  renderHops();
  updateHeading();
  return view;
}
