// Werkzeuge → Subnetz: Subnetz-Rechner, Subnetting und „Liegt IP X im Netz Y?“.
// Rechnet komplett im Frontend (offline), Logik in src/subnet.ts (getestet).
import { ipToInt, maskToPrefix } from "../../netutil";
import { onStateChange, sortedAdapters, state } from "../../state";
import { calc, inNet, ip, parseInput, splitByCount, splitByHosts, toBinary, type SplitResult } from "../../subnet";
import { h, replaceChildren, type Child } from "../../ui/dom";
import { status } from "../../ui/statusbar";
import { choice, copyable, kvRow, panel, prompt, table, tag, tbutton } from "../../ui/widgets";

const COUNTS = [2, 4, 8, 16, 32, 64, 128, 256];
const fmt = (n: number) => n.toLocaleString("de-CH");

/** Binärdarstellung: Netzbits hell, Hostbits gedimmt, Punkte zwischen den Oktetten. */
function binary(n: number, prefix: number): HTMLElement {
  const bits = toBinary(n);
  const out = h("span", { class: "bin" });
  let bitIndex = 0;
  let run = "";
  let runNet: boolean | null = null;
  const flush = () => {
    if (run) out.append(h("span", { class: runNet ? "bright" : "dim" }, run));
    run = "";
  };
  for (const ch of bits) {
    if (ch === ".") {
      flush();
      out.append(h("span", { class: "dim" }, "."));
      continue;
    }
    const isNet = bitIndex < prefix;
    if (runNet !== isNet) flush();
    runNet = isNet;
    run += ch;
    bitIndex++;
  }
  flush();
  return out;
}

export interface SubnetView {
  el: HTMLElement;
  /** Eingabe vorbelegen (z. B. aus der Befehlspalette: "subnet 10.0.0.1/8") */
  prefill(text: string): void;
}

export function createSubnet(): SubnetView {
  const heading = prompt("ipcalc");
  const input = (value: string, placeholder: string, label: string, short = false) =>
    h("input", {
      class: short ? "tinput tinput-short" : "tinput",
      type: "text",
      value,
      placeholder,
      spellcheck: "false",
      autocomplete: "off",
      "aria-label": label,
    });
  const field = (el: HTMLInputElement) => h("span", { class: "input-wrap" }, h("span", { class: "dim" }, "> "), el);

  const addrIn = input("192.168.10.55/24", "z. B. 192.168.10.55/24", "IPv4-Adresse mit Präfix");
  const maskIn = input("", "optional, z. B. /24", "Subnetzmaske (255.255.255.0 oder /24)", true);
  const adapterSel = h("select", { class: "tselect", "aria-label": "Adapter-Adresse" });
  const takeBtn = tbutton("Aus Adapter übernehmen", {
    title: "IPv4-Adresse und Maske des gewählten Adapters übernehmen",
    onclick: () => {
      if (!adapterSel.value) return;
      addrIn.value = adapterSel.value;
      maskIn.value = "";
      update();
      status(`übernommen: ${adapterSel.value}`, "ok");
    },
  });
  const inputMsg = h("div", {});
  const resultBody = h("div", {});

  // Subnetting
  let splitMode: { kind: "count" | "hosts"; n: number } = { kind: "count", n: 4 };
  const countChoice = choice(
    COUNTS.map((n) => ({ value: n, label: String(n) })),
    4,
    (n) => {
      splitMode = { kind: "count", n };
      hostsIn.value = "";
      renderSplit();
    },
  );
  const hostsIn = input("", "z. B. 50", "Benötigte Hosts pro Subnetz", true);
  hostsIn.classList.add("tinput-tiny");
  const hostsBtn = tbutton("Berechnen", {
    onclick: () => {
      const n = Number(hostsIn.value.trim());
      splitMode = { kind: "hosts", n: Number.isInteger(n) ? n : -1 };
      countChoice.set(-1);
      renderSplit();
    },
  });
  const splitBody = h("div", {});

  // Liegt IP im Netz?
  const checkIpIn = input("192.168.10.200", "IP-Adresse", "IP-Adresse", true);
  const checkNetIn = input("", "Netz, z. B. 192.168.10.0/24", "Netz", true);
  let netTouched = false; // Netzfeld folgt der Eingabe oben, bis man es selbst ändert
  const checkBody = h("div", {});

  const inputPanel = panel(
    "EINGABE",
    {},
    kvRow("Adresse", field(addrIn)),
    kvRow("Maske", field(maskIn)),
    kvRow("Adapter", h("span", { class: "row-actions wrap-actions" }, h("span", { class: "select-wrap" }, adapterSel), takeBtn)),
    inputMsg,
  );
  const resultPanel = panel("ERGEBNIS", { right: [h("span", { class: "dim" }, "Klick kopiert")] }, resultBody);
  const splitPanel = panel(
    "SUBNETTING",
    {},
    kvRow("Teilen in", countChoice.el),
    kvRow("oder je", h("span", { class: "row-actions" }, field(hostsIn), h("span", { class: "dim" }, "Hosts "), hostsBtn)),
    splitBody,
  );
  const checkPanel = panel(
    "LIEGT IP IM NETZ?",
    {},
    kvRow("IP", field(checkIpIn)),
    kvRow("Netz", field(checkNetIn)),
    checkBody,
  );
  const el = h(
    "div",
    { class: "subview subnet" },
    heading.el,
    h("div", { class: "stack" }, inputPanel.el, resultPanel.el, splitPanel.el, checkPanel.el),
  );

  let current: { ip: number; prefix: number } | null = null;

  const renderAdapters = () => {
    const prev = adapterSel.value;
    const opts: HTMLOptionElement[] = [];
    for (const a of sortedAdapters(state.adapters)) {
      for (const e of a.ipv4) {
        const p = maskToPrefix(e.subnetMask);
        if (p === null) continue;
        const v = `${e.address}/${p}`;
        opts.push(h("option", { value: v }, `${a.name} – ${v}`));
      }
    }
    if (!opts.length) opts.push(h("option", { value: "" }, "keine IPv4-Adressen"));
    adapterSel.replaceChildren(...opts);
    if (opts.some((o) => o.value === prev)) adapterSel.value = prev;
    takeBtn.disabled = !adapterSel.value;
  };

  function update(): void {
    const r = parseInput(addrIn.value, maskIn.value);
    if ("error" in r) {
      current = null;
      heading.set(`ipcalc ${addrIn.value.trim() || "<adresse>"}`);
      replaceChildren(inputMsg, h("p", { class: "tag-err" }, r.error));
      replaceChildren(resultBody, h("span", { class: "dim" }, "–"));
      replaceChildren(splitBody);
      renderCheck();
      return;
    }
    current = { ip: r.ip, prefix: r.prefix };
    heading.set(`ipcalc ${ip(r.ip)}/${r.prefix}`);
    replaceChildren(
      inputMsg,
      r.guessed ? h("p", { class: "dim" }, `Keine Maske angegeben – Standard der Klasse verwendet: /${r.prefix}`) : null,
    );
    const s = calc(r.ip, r.prefix);
    const v = (n: number) => copyable(ip(n));
    replaceChildren(
      resultBody,
      kvRow("Adresse", copyable(`${ip(s.ip)}/${s.prefix}`)),
      kvRow("Netzadresse", v(s.network)),
      kvRow("Broadcast", s.prefix >= 31 ? h("span", { class: "dim" }, `– (${ip(s.broadcast)})`) : v(s.broadcast)),
      kvRow("Subnetzmaske", h("span", { class: "row-actions" }, v(s.mask), copyable(`/${s.prefix}`))),
      kvRow("Wildcard", v(s.wildcard)),
      kvRow("Erster Host", v(s.first)),
      kvRow("Letzter Host", v(s.last)),
      kvRow("Nutzbare Hosts", h("span", {}, fmt(s.usable), h("span", { class: "dim" }, ` von ${fmt(s.total)} Adressen`))),
      kvRow("Klasse / Typ", h("span", {}, `${s.cls}`, h("span", { class: "dim" }, " · "), s.type)),
      s.note ? h("p", { class: "note dim" }, s.note) : null,
      h("div", { class: "spacer-line" }),
      kvRow("IP binär", binary(s.ip, s.prefix)),
      kvRow("Maske binär", binary(s.mask, s.prefix)),
      h("p", { class: "dim" }, "hell = Netzanteil (", String(s.prefix), " Bit), gedimmt = Hostanteil (", String(32 - s.prefix), " Bit)"),
    );
    if (!netTouched) checkNetIn.value = `${ip(s.network)}/${s.prefix}`;
    renderSplit();
    renderCheck();
  }

  function renderSplit(): void {
    if (!current) return replaceChildren(splitBody);
    const { ip: addr, prefix } = current;
    const r: SplitResult | string =
      splitMode.kind === "count" ? splitByCount(addr, prefix, splitMode.n) : splitByHosts(addr, prefix, splitMode.n);
    if (typeof r === "string") return replaceChildren(splitBody, h("p", { class: "tag-err note" }, r));
    const hosts = calc(r.networks[0], r.prefix).usable;
    const rows = r.networks.map((n, i) => ({ i, s: calc(n, r.prefix) }));
    const more = r.count - r.networks.length;
    replaceChildren(
      splitBody,
      h(
        "p",
        { class: "note" },
        `${fmt(r.count)} Subnetze à /${r.prefix}`,
        h("span", { class: "dim" }, ` · je ${fmt(hosts)} nutzbare Hosts${splitMode.kind === "hosts" ? " (klassisch 2^n − 2)" : ""}`),
      ),
      table(
        [
          { title: "#", width: "5ch", align: "right", cell: (x) => h("span", { class: "dim" }, String(x.i + 1)) },
          { title: "Subnetz", width: "20ch", cell: (x) => copyable(`${ip(x.s.network)}/${x.s.prefix}`) },
          {
            title: "Bereich",
            width: "minmax(0, 1fr)",
            cell: (x) => h("span", { class: "row-actions" }, copyable(ip(x.s.first)), h("span", { class: "dim" }, "–"), copyable(ip(x.s.last))),
          },
          { title: "Broadcast", width: "16ch", cell: (x) => (x.s.prefix >= 31 ? h("span", { class: "dim" }, "–") : copyable(ip(x.s.broadcast))) },
        ],
        rows,
      ),
      more > 0 ? h("p", { class: "dim note" }, `… und ${fmt(more)} weitere (angezeigt werden die ersten ${r.networks.length}).`) : null,
    );
  }

  function renderCheck(): void {
    const ipN = ipToInt(checkIpIn.value);
    const net = parseInput(checkNetIn.value);
    let line: Child;
    if (ipN === null) line = h("span", { class: "tag-err" }, `„${checkIpIn.value.trim()}“ ist keine gültige IPv4-Adresse.`);
    else if ("error" in net) line = h("span", { class: "tag-err" }, net.error);
    else {
      const inside = inNet(ipN, net.ip, net.prefix);
      const netText = `${ip(calc(net.ip, net.prefix).network)}/${net.prefix}`;
      line = h(
        "span",
        {},
        tag(inside ? "[JA]" : "[NEIN]", inside ? "ok" : "err"),
        ` ${ip(ipN)} liegt ${inside ? "" : "nicht "}in ${netText}`,
        inside ? null : h("span", { class: "dim" }, ` (gehört zu ${ip(calc(ipN, net.prefix).network)}/${net.prefix})`),
      );
    }
    replaceChildren(checkBody, h("p", { class: "note" }, line));
  }

  addrIn.addEventListener("input", update);
  maskIn.addEventListener("input", update);
  hostsIn.addEventListener("keydown", (e) => {
    if (e.key === "Enter") hostsBtn.click();
  });
  checkIpIn.addEventListener("input", renderCheck);
  checkNetIn.addEventListener("input", () => {
    netTouched = checkNetIn.value.trim() !== "";
    renderCheck();
  });

  onStateChange(renderAdapters);
  renderAdapters();
  update();

  return {
    el,
    prefill: (text: string) => {
      addrIn.value = text.trim();
      maskIn.value = "";
      update();
      addrIn.focus();
    },
  };
}
