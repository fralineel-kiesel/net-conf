// Ansicht "Übersicht": ein Panel pro Netzwerkadapter, Zeilen wie bei ipconfig /all.
import { onStateChange, setState, state } from "../state";
import type { AdapterInfo } from "../types";
import { copyText, formatUnix, h, prefs, replaceChildren } from "../ui/dom";
import { status } from "../ui/statusbar";
import { checkbox, kvRow, panel, prompt, tag } from "../ui/widgets";

export function createOverview(): HTMLElement {
  const grid = h("div", { class: "panel-grid" });
  const hideBox = checkbox("Getrennte Adapter ausblenden", state.hideDisconnected, (v) => {
    prefs.set("hideDisconnected", v ? "1" : "0");
    setState({ hideDisconnected: v });
  });

  const view = h(
    "section",
    { class: "view", "data-view": "overview" },
    prompt("ipconfig /all").el,
    h("div", { class: "toolbar" }, hideBox, h("span", { class: "dim" }, "Klick auf einen Wert kopiert ihn.")),
    grid,
  );

  const render = () => {
    if (state.loading && state.adapters.length === 0) {
      replaceChildren(grid, h("p", { class: "dim" }, "lade Adapter …"));
      return;
    }
    if (state.error) {
      replaceChildren(grid, h("p", { class: "tag-err" }, "Die Adapter konnten nicht gelesen werden: ", state.error));
      return;
    }
    const visible = state.adapters.filter((a) => !state.hideDisconnected || a.connected);
    if (visible.length === 0) {
      replaceChildren(
        grid,
        h("p", { class: "dim" }, state.hideDisconnected ? "Keine verbundenen Adapter gefunden." : "Keine Adapter gefunden."),
      );
      return;
    }
    replaceChildren(grid, ...visible.map(adapterPanel));
  };

  onStateChange(render);
  render();
  return view;
}

/** Klickbarer Wert: kopiert sich selbst, Rückmeldung in der Statusleiste. */
function copyValue(value: string): HTMLElement {
  return h(
    "button",
    {
      class: "value",
      type: "button",
      title: "Klicken zum Kopieren",
      onclick: async () => {
        if (await copyText(value)) status(`kopiert: ${value}`, "ok");
        else status("Kopieren fehlgeschlagen", "error");
      },
    },
    value,
  );
}

function adapterPanel(a: AdapterInfo): HTMLElement {
  // [Bezeichnung (wie ipconfig), Werte, auch leer anzeigen?]
  const rows: [string, string[], boolean][] = [
    ["Physische Adresse", a.mac ? [a.mac] : [], true],
    ["IPv4-Adresse", a.ipv4.map((x) => x.address), a.connected],
    ["Subnetzmaske", a.ipv4.map((x) => x.subnetMask), false],
    ["Standardgateway", a.gateways, a.connected],
    ["DNS-Server", a.dnsServers, a.connected],
    ["IPv6-Adresse", a.ipv6, false],
    ["DHCP-Server", a.dhcpServer ? [a.dhcpServer] : [], false],
    ["Lease erhalten", a.leaseObtained ? [formatUnix(a.leaseObtained)] : [], false],
    ["Lease läuft ab", a.leaseExpires ? [formatUnix(a.leaseExpires)] : [], false],
    ["DNS-Suffix", a.dnsSuffix ? [a.dnsSuffix] : [], false],
  ];

  const p = panel(a.name || "(ohne Namen)", {
    cls: "adapter",
    right: [
      a.connected ? tag("[ONLINE]", "ok") : tag("[OFFLINE]", "dim"),
      tag(a.dhcpEnabled ? "[DHCP]" : "[STATISCH]"),
    ],
  });
  p.title.title = a.name;
  p.body.append(h("p", { class: "dim desc", title: a.description }, a.description));
  p.body.append(kvRow("DHCP aktiviert", h("span", { class: "plain" }, a.dhcpEnabled ? "Ja" : "Nein")));
  for (const [label, values, always] of rows) {
    if (values.length === 0 && !always) continue;
    p.body.append(kvRow(label, ...(values.length ? values.map(copyValue) : [h("span", { class: "dim" }, "—")])));
  }
  return p.el;
}
