// Ansicht "Tabellen": ARP-Tabelle (Nachbarn) und Routing-Tabelle.
import { backend, errorText } from "../api";
import { logToConsole } from "../commands";
import type { NeighborEntry, RouteEntry } from "../types";
import { h, prefs, replaceChildren } from "../ui/dom";
import { status } from "../ui/statusbar";
import { checkbox, copyable, kvRow, panel, prompt, radio, table, tabs, tag, tbutton } from "../ui/widgets";

type TabId = "arp" | "routes";
type Family = "all" | "4" | "6";

/** Multicast/Broadcast erkennt man sicher an der MAC-Adresse. */
function isMulticastOrBroadcast(e: NeighborEntry): boolean {
  const mac = e.mac.toUpperCase();
  return mac === "FF-FF-FF-FF-FF-FF" || mac.startsWith("01-00-5E") || mac.startsWith("33-33");
}

export interface TablesView {
  el: HTMLElement;
  /** Beim ersten Anzeigen laden (nicht schon beim App-Start) */
  activate(): void;
}

export function createTables(): TablesView {
  let tab: TabId = prefs.get("tablesTab", "arp") === "routes" ? "routes" : "arp";
  let family: Family = "all";
  let hideMulticast = true;
  let filterText = "";
  let arp: NeighborEntry[] | null = null;
  let routes: RouteEntry[] | null = null;
  let error: string | null = null;
  let loading = false;
  let loadedOnce = false;

  const heading = prompt("");
  const filterInput = h("input", {
    class: "tinput tinput-short",
    type: "text",
    spellcheck: "false",
    autocomplete: "off",
    placeholder: "IP, MAC, Interface …",
    "aria-label": "Filter",
  });
  const familyRadio = radio(
    [
      { value: "all" as Family, label: "Alle" },
      { value: "4" as Family, label: "IPv4" },
      { value: "6" as Family, label: "IPv6" },
    ],
    family,
    (v) => {
      family = v;
      render();
    },
  );
  const mcBox = checkbox("Multicast/Broadcast ausblenden", hideMulticast, (v) => {
    hideMulticast = v;
    render();
  });
  const mcRow = kvRow("Anzeigen", mcBox);
  const refreshBtn = tbutton("Aktualisieren", { onclick: () => void load() });
  const count = h("span", { class: "dim" });
  const body = h("div", {});

  const filterPanel = panel(
    "FILTER",
    {},
    kvRow("Suche", h("span", { class: "input-wrap" }, h("span", { class: "dim" }, "> "), filterInput)),
    kvRow("Familie", familyRadio),
    mcRow,
    h("div", { class: "panel-actions" }, refreshBtn),
  );
  const dataPanel = panel("ARP-TABELLE", { right: [count] }, body);

  const bar = tabs(
    [
      { value: "arp" as TabId, label: "ARP" },
      { value: "routes" as TabId, label: "Routen" },
    ],
    tab,
    (v) => {
      tab = v;
      prefs.set("tablesTab", v);
      render();
    },
  );

  const el = h(
    "section",
    { class: "view", "data-view": "tables" },
    bar.el,
    h("div", { class: "subview" }, heading.el, h("div", { class: "stack" }, filterPanel.el, dataPanel.el)),
  );

  const matches = (fields: string[]) => {
    const q = filterText.trim().toLowerCase();
    return !q || fields.some((f) => f.toLowerCase().includes(q));
  };

  function render(): void {
    heading.set(tab === "arp" ? "arp -a" : "route print");
    dataPanel.title.textContent = tab === "arp" ? "ARP-TABELLE" : "ROUTING-TABELLE";
    mcRow.hidden = tab !== "arp";

    if (loading && !loadedOnce) {
      replaceChildren(body, h("span", { class: "dim" }, "lade …"));
      count.textContent = "";
      return;
    }
    if (error) {
      replaceChildren(body, h("span", { class: "tag-err" }, error));
      count.textContent = "";
      return;
    }

    if (tab === "arp") {
      const all = arp ?? [];
      const rows = all.filter(
        (e) =>
          (family === "all" || String(e.family) === family) &&
          (!hideMulticast || !isMulticastOrBroadcast(e)) &&
          matches([e.address, e.mac, e.interface, e.state]),
      );
      count.textContent = `${rows.length} von ${all.length}`;
      replaceChildren(
        body,
        table(
          [
            { title: "Adresse", width: "minmax(16ch, 30ch)", cell: (e: NeighborEntry) => copyable(e.address) },
            { title: "MAC-Adresse", width: "19ch", cell: (e) => (e.mac ? copyable(e.mac) : tag("—", "dim")) },
            { title: "Typ", width: "11ch", cell: (e) => (e.permanent ? "statisch" : "dynamisch") },
            {
              title: "Zustand",
              width: "14ch",
              cell: (e) => tag(e.state, e.state === "erreichbar" ? "ok" : e.state === "unerreichbar" ? "err" : "plain"),
            },
            { title: "Interface", width: "minmax(0, 1fr)", cell: (e) => h("span", { class: "dim" }, e.interface) },
          ],
          rows,
          all.length ? "keine Einträge für diesen Filter" : "keine Einträge",
        ),
      );
    } else {
      const all = routes ?? [];
      const rows = all.filter(
        (r) => (family === "all" || String(r.family) === family) && matches([r.destination, r.gateway, r.interface]),
      );
      count.textContent = `${rows.length} von ${all.length}`;
      replaceChildren(
        body,
        table(
          [
            { title: "Ziel", width: "minmax(18ch, 30ch)", cell: (r: RouteEntry) => copyable(r.destination) },
            {
              title: "Gateway",
              width: "minmax(16ch, 28ch)",
              cell: (r) => (r.gateway ? copyable(r.gateway) : h("span", { class: "dim" }, "auf Verbindung")),
            },
            { title: "Metrik", width: "8ch", cell: (r) => String(r.metric), align: "right" },
            { title: "Interface", width: "minmax(0, 1fr)", cell: (r) => h("span", { class: "dim" }, r.interface) },
          ],
          rows,
          all.length ? "keine Einträge für diesen Filter" : "keine Einträge",
        ),
      );
    }
  }

  async function load(): Promise<void> {
    if (loading) return;
    loading = true;
    refreshBtn.textContent = "lädt …";
    refreshBtn.disabled = true;
    render();
    // Beide Tabellen gleichzeitig laden; ein Fehler bei einer betrifft die andere nicht
    const [a, r] = await Promise.allSettled([backend.getArpTable(), backend.getRouteTable()]);
    arp = a.status === "fulfilled" ? a.value : null;
    routes = r.status === "fulfilled" ? r.value : null;
    const failed = [a, r].find((x): x is PromiseRejectedResult => x.status === "rejected");
    error = failed ? errorText(failed.reason) : null;
    loading = false;
    loadedOnce = true;
    refreshBtn.textContent = "Aktualisieren";
    refreshBtn.disabled = false;
    render();
    if (error) {
      status(error, "error");
    } else {
      status(`Tabellen geladen: ${arp?.length ?? 0} Nachbarn, ${routes?.length ?? 0} Routen`);
      logToConsole("arp -a  &  route print", [
        `${arp?.length ?? 0} ARP-Einträge, ${routes?.length ?? 0} Routen gelesen (Windows-API)`,
      ]);
    }
  }

  filterInput.addEventListener("input", () => {
    filterText = filterInput.value;
    render();
  });

  render();
  return {
    el,
    activate: () => {
      if (!loadedOnce) void load();
    },
  };
}
