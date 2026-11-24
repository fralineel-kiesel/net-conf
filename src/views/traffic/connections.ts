// Traffic → Verbindungen: TCP/UDP-Verbindungen mit Prozess (wie netstat -ano,
// aber über die Windows-API, ohne Textausgabe zu parsen).
//
// * Textfilter über alle Spalten, Umschalter [Alle] [LISTEN] [ESTABLISHED]
// * Sortierung per Klick auf den Spaltenkopf
// * Auto-Aktualisierung alle 2 s (Standard aus, nur solange der Reiter sichtbar ist)
// * Klick auf eine Adresse kopiert sie, [ Auflösen ] = Reverse-DNS nur für diese Zeile
// * Höchstens 500 Zeilen (sonst wird die Seite träge) – Hinweis "Filter verwenden"
// * Bewusst KEIN "Prozess beenden".
import { backend, errorText } from "../../api";
import { logToConsole } from "../../commands";
import {
  endpoint,
  hasRemote,
  matchesFilter,
  MAX_CONN_ROWS,
  sortConnections,
  type ConnFilter,
  type ConnSortKey,
} from "../../traffic";
import type { Connection } from "../../types";
import { h, prefs, replaceChildren } from "../../ui/dom";
import { status } from "../../ui/statusbar";
import { checkbox, choice, copyable, kvRow, panel, prompt, table, tag, tbutton, type Column } from "../../ui/widgets";

const AUTO_MS = 2000;

export interface ConnectionsView {
  el: HTMLElement;
  activate(): void;
  deactivate(): void;
}

export function createConnections(): ConnectionsView {
  let rows: Connection[] | null = null;
  let error: string | null = null;
  let loading = false;
  let loadedOnce = false;
  let filter: ConnFilter = (["all", "listen", "established"].includes(prefs.get("connFilter", "all"))
    ? prefs.get("connFilter", "all")
    : "all") as ConnFilter;
  let sortKey: ConnSortKey = "local";
  let sortDir: "asc" | "desc" = "asc";
  let auto = false; // Standard aus
  let active = false;
  let timer: number | undefined;
  /** Reverse-DNS-Ergebnisse je Adresse: Name, null = kein Name, "…" = läuft */
  const resolved = new Map<string, string | null>();
  const pending = new Set<string>();

  const heading = prompt("netstat -ano");
  const filterInput = h("input", {
    class: "tinput tinput-short",
    type: "text",
    spellcheck: "false",
    autocomplete: "off",
    placeholder: "Adresse, Port, Prozess, PID …",
    "aria-label": "Filter",
  });
  const filterChoice = choice<ConnFilter>(
    [
      { value: "all", label: "Alle" },
      { value: "listen", label: "LISTEN", title: "Wartende TCP-Ports und gebundene UDP-Ports" },
      { value: "established", label: "ESTABLISHED", title: "Aufgebaute TCP-Verbindungen" },
    ],
    filter,
    (v) => {
      filter = v;
      prefs.set("connFilter", v);
      render();
    },
  );
  const autoBox = checkbox("alle 2 s aktualisieren", auto, (v) => {
    auto = v;
    schedule();
  });
  const reloadBtn = tbutton("Neu laden", { onclick: () => void load() });
  const count = h("span", { class: "dim" });
  const body = h("div", {});

  const filterPanel = panel(
    "FILTER",
    {},
    kvRow("Suche", h("span", { class: "input-wrap" }, h("span", { class: "dim" }, "> "), filterInput)),
    kvRow("Zustand", filterChoice.el),
    kvRow("Automatisch", autoBox),
    h("div", { class: "panel-actions" }, reloadBtn),
  );
  const dataPanel = panel("VERBINDUNGEN", { right: [count] }, body);
  const el = h(
    "div",
    { class: "subview" },
    heading.el,
    h(
      "div",
      { class: "stack" },
      filterPanel.el,
      dataPanel.el,
      h("p", { class: "dim wrap" }, "Klick auf eine Adresse kopiert sie. „(kein Zugriff)“: Windows verrät den Prozessnamen nur mit Adminrechten."),
    ),
  );

  const setSort = (key: ConnSortKey) => {
    if (sortKey === key) sortDir = sortDir === "asc" ? "desc" : "asc";
    else {
      sortKey = key;
      sortDir = "asc";
    }
    render();
  };

  /** Adresse als "ip:port"; Klick kopiert nur die IP (ohne Zonen-Index) */
  const addrCell = (addr: string, port: number, family: 4 | 6) => {
    const text = endpoint(addr, port, family);
    if (!addr) return h("span", { class: "dim" }, text);
    return h("span", { class: "clip", title: text }, copyable(addr.split("%")[0], text));
  };

  const remoteCell = (c: Connection) => {
    if (!c.remoteAddr) return h("span", { class: "dim" }, "*:*");
    const ip = c.remoteAddr.split("%")[0];
    const addr = addrCell(c.remoteAddr, c.remotePort, c.family);
    // Zweite Zeile nur, wenn aufgelöst wurde (sonst bleiben alle Zeilen gleich hoch)
    if (!resolved.has(ip)) return addr;
    const name = resolved.get(ip);
    return h(
      "span",
      { class: "cell-lines" },
      addr,
      h("span", { class: "resolved ellipsis", title: name ?? "" }, name ? `→ ${name}` : "→ (kein Name)"),
    );
  };

  const stateCell = (c: Connection) => {
    if (!c.state) return h("span", { class: "dim" }, "–");
    if (c.state === "ESTABLISHED") return tag(c.state, "ok");
    if (c.state === "LISTEN") return tag(c.state, "plain");
    return tag(c.state, "dim");
  };

  function render(): void {
    if (loading && !loadedOnce) {
      replaceChildren(body, h("span", { class: "dim" }, "lade …"));
      return;
    }
    if (error) {
      count.textContent = "";
      replaceChildren(body, h("p", { class: "tag-err wrap" }, error));
      return;
    }
    const all = rows ?? [];
    const filtered = all.filter((c) => matchesFilter(c, filter, filterInput.value));
    const sorted = sortConnections(filtered, sortKey, sortDir);
    const shown = sorted.slice(0, MAX_CONN_ROWS);
    count.textContent = `${filtered.length} von ${all.length}`;

    const col = (title: string, key: ConnSortKey, width: string, cell: (c: Connection) => ReturnType<Column<Connection>["cell"]>, align?: "right"): Column<Connection> => ({
      title,
      width,
      cell,
      align,
      onSort: () => setSort(key),
      sorted: sortKey === key ? sortDir : undefined,
    });

    replaceChildren(
      body,
      h(
        "div",
        { class: "conn-table" },
        table<Connection>(
          [
            col("Proto", "proto", "5ch", (c) => c.proto),
            col("Lokal", "local", "minmax(0, 1fr)", (c) => addrCell(c.localAddr, c.localPort, c.family)),
            col("Remote", "remote", "minmax(0, 1.2fr)", remoteCell),
            col("Status", "state", "12ch", stateCell),
            col("PID", "pid", "6ch", (c) => String(c.pid), "right"),
            col("Prozess", "process", "minmax(8ch, 0.8fr)", (c) =>
              h("span", { class: c.process.startsWith("(") ? "ellipsis dim" : "ellipsis", title: c.process }, c.process),
            ),
            {
              title: "",
              width: "12ch",
              cell: (c) => {
                if (!hasRemote(c)) return "";
                const ip = c.remoteAddr.split("%")[0];
                if (pending.has(ip)) return h("span", { class: "dim" }, "löse auf …");
                if (resolved.has(ip)) return "";
                return tbutton("Auflösen", { title: `Reverse-DNS für ${ip}`, onclick: () => void resolve(ip) });
              },
            },
          ],
          shown,
          all.length ? "keine Verbindungen für diesen Filter" : "keine Verbindungen",
        ),
      ),
      filtered.length > shown.length
        ? h(
            "p",
            { class: "note wrap" },
            tag("[!]", "err"),
            ` Es werden nur ${MAX_CONN_ROWS} von ${filtered.length} Zeilen angezeigt – Filter verwenden.`,
          )
        : null,
    );
  }

  async function load(): Promise<void> {
    if (loading) return;
    loading = true;
    reloadBtn.textContent = "lädt …";
    reloadBtn.disabled = true;
    render();
    try {
      rows = await backend.getConnections();
      error = null;
    } catch (err) {
      error = errorText(err);
    }
    const first = !loadedOnce;
    loading = false;
    loadedOnce = true;
    reloadBtn.textContent = "Neu laden";
    reloadBtn.disabled = false;
    render();
    if (error) status(error, "error");
    else if (first || !auto) {
      // Bei der Auto-Aktualisierung nicht alle 2 s die Konsole füllen
      const tcp = rows?.filter((r) => r.proto === "TCP").length ?? 0;
      status(`Verbindungen geladen: ${rows?.length ?? 0} (TCP ${tcp}, UDP ${(rows?.length ?? 0) - tcp})`);
      logToConsole("netstat -ano", [`${rows?.length ?? 0} Einträge gelesen (Windows-API, TCP ${tcp}, UDP ${(rows?.length ?? 0) - tcp})`]);
    }
  }

  async function resolve(ip: string): Promise<void> {
    if (pending.has(ip)) return;
    pending.add(ip);
    render();
    try {
      const name = await backend.reverseDns(ip);
      resolved.set(ip, name);
      status(name ? `${ip} → ${name}` : `${ip}: kein Name (PTR) gefunden`, name ? "ok" : "info");
    } catch (err) {
      status(errorText(err), "error");
    } finally {
      pending.delete(ip);
      render();
    }
  }

  /** Auto-Aktualisierung: nur wenn eingeschaltet UND der Reiter sichtbar ist */
  function schedule(): void {
    window.clearTimeout(timer);
    if (!auto || !active) return;
    timer = window.setTimeout(async () => {
      await load();
      schedule();
    }, AUTO_MS);
  }

  filterInput.addEventListener("input", render);

  render();
  return {
    el,
    activate: () => {
      active = true;
      if (!loadedOnce) void load();
      schedule();
    },
    deactivate: () => {
      active = false;
      window.clearTimeout(timer);
    },
  };
}
