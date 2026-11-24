// Ansicht "Übersicht": eine Karte pro Netzwerkadapter.
import { state, onStateChange } from "../state";
import type { AdapterInfo } from "../types";
import { copyText, formatUnix, h, prefs, replaceChildren } from "../ui/dom";
import { toast } from "../ui/toast";

export function createOverview(): HTMLElement {
  const hideToggle = h("input", { type: "checkbox", class: "switch-input", id: "hide-disconnected" });
  hideToggle.checked = prefs.get("hideDisconnected", "1") === "1";

  const summary = h("span", { class: "muted small" });
  const grid = h("div", { class: "cards" });

  const view = h(
    "section",
    { class: "view", "data-view": "overview" },
    h(
      "div",
      { class: "view-header" },
      h("div", {}, h("h1", {}, "Übersicht"), h("p", { class: "muted" }, "Netzwerkadapter wie bei ipconfig /all – Klick auf einen Wert kopiert ihn.")),
      h(
        "div",
        { class: "view-tools" },
        summary,
        h("label", { class: "switch", for: "hide-disconnected" }, hideToggle, h("span", { class: "switch-track" }), "Getrennte Adapter ausblenden"),
      ),
    ),
    grid,
  );

  const render = () => {
    if (state.loading && state.adapters.length === 0) {
      replaceChildren(grid, h("div", { class: "empty" }, h("span", { class: "spinner" }), "Lade Adapter …"));
      return;
    }
    if (state.error) {
      replaceChildren(grid, h("div", { class: "empty empty-error" }, "Die Adapter konnten nicht gelesen werden: ", state.error));
      return;
    }
    const hide = hideToggle.checked;
    const visible = state.adapters.filter((a) => !hide || a.connected);
    const hidden = state.adapters.length - visible.length;
    summary.textContent =
      `${visible.length} Adapter` + (hidden > 0 ? ` · ${hidden} getrennte ausgeblendet` : "");

    if (visible.length === 0) {
      replaceChildren(grid, h("div", { class: "empty" }, hide ? "Keine verbundenen Adapter gefunden." : "Keine Adapter gefunden."));
      return;
    }
    replaceChildren(grid, ...visible.map(adapterCard));
  };

  hideToggle.addEventListener("change", () => {
    prefs.set("hideDisconnected", hideToggle.checked ? "1" : "0");
    render();
  });
  onStateChange(render);
  render();
  return view;
}

/** Klickbarer Wert: kopiert sich selbst in die Zwischenablage. */
function copyValue(value: string): HTMLElement {
  return h(
    "button",
    {
      class: "value",
      title: "Klicken zum Kopieren",
      onclick: async () => toast((await copyText(value)) ? "Kopiert" : "Kopieren fehlgeschlagen"),
    },
    value,
  );
}

function adapterCard(a: AdapterInfo): HTMLElement {
  // [Bezeichnung, Werte, immer anzeigen?]
  const rows: [string, string[], boolean][] = [
    ["IPv4-Adresse", a.ipv4.map((x) => x.address), a.connected],
    ["Subnetzmaske", a.ipv4.map((x) => x.subnetMask), false],
    ["Standardgateway", a.gateways, a.connected],
    ["DNS-Server", a.dnsServers, a.connected],
    ["IPv6-Adresse", a.ipv6, false],
    ["MAC-Adresse", a.mac ? [a.mac] : [], true],
    ["DHCP-Server", a.dhcpServer ? [a.dhcpServer] : [], false],
    ["Lease erhalten", a.leaseObtained ? [formatUnix(a.leaseObtained)] : [], false],
    ["Lease läuft ab", a.leaseExpires ? [formatUnix(a.leaseExpires)] : [], false],
    ["DNS-Suffix", a.dnsSuffix ? [a.dnsSuffix] : [], false],
  ];

  const dl = h("dl", { class: "kv" });
  for (const [label, values, always] of rows) {
    if (values.length === 0 && !always) continue;
    dl.append(
      h("dt", {}, label),
      h(
        "dd",
        {},
        ...(values.length ? values.map(copyValue) : [h("span", { class: "muted" }, "—")]),
      ),
    );
  }

  return h(
    "article",
    { class: `card adapter ${a.connected ? "is-up" : "is-down"}` },
    h(
      "header",
      { class: "card-header" },
      h("span", { class: "status-dot", title: a.connected ? "Verbunden" : "Getrennt" }),
      h("div", { class: "card-title" }, h("h2", {}, a.name || "(ohne Namen)"), h("p", { class: "muted small" }, a.description)),
      h(
        "div",
        { class: "card-badges" },
        h("span", { class: `pill ${a.dhcpEnabled ? "pill-accent" : ""}` }, a.dhcpEnabled ? "DHCP" : "Statisch"),
        h("span", { class: `pill ${a.connected ? "pill-ok" : ""}` }, a.connected ? "verbunden" : "getrennt"),
      ),
    ),
    dl,
  );
}
