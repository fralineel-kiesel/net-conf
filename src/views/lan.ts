// Ansicht "LAN" (F6): Reiter "Scanner" (Geräte im eigenen Subnetz finden)
// und "Wake-on-LAN" (Geräte per Magic Packet aufwecken).
//
// Sicherheit: Es gibt kein freies Feld für IP-Bereiche. Gewählt wird nur ein
// eigener Adapter + eigene Adresse; das Subnetz bestimmt und prüft das Backend
// (privat/Link-Local, max. /22).
import { backend, errorText } from "../api";
import { logToConsole } from "../commands";
import { config, onConfigChange, updateConfig } from "../config";
import { events } from "../events";
import { pingHost } from "../nav";
import { compareIp, hostCount, ipv4Gateway, isIpv4, isRandomMac, maskToPrefix, networkOf, normalizeMac, scanBlockReason } from "../netutil";
import { onStateChange, primaryAdapter, state } from "../state";
import type { LanHost, WolDevice } from "../types";
import { h, prefs, replaceChildren } from "../ui/dom";
import { confirmDialog } from "../ui/modal";
import { status } from "../ui/statusbar";
import { bar, choice, copyable, kvRow, panel, prompt, table, tabs, tag, tbutton } from "../ui/widgets";

type TabId = "scan" | "wol";
type SortKey = "ip" | "name" | "latency";

/** Ein wählbares Netz: Adapter + eigene IPv4-Adresse */
interface NetOption {
  key: string;
  adapter: string;
  address: string;
  prefix: number | null;
  network: string | null;
  /** null = darf gescannt werden */
  blocked: string | null;
  gateway: string | undefined;
}

export interface LanView {
  el: HTMLElement;
  /** Nächster Reiter (F6, wenn LAN schon offen ist) */
  next(): void;
}

export function createLan(): LanView {
  let tab: TabId = prefs.get("lanTab", "scan") === "wol" ? "wol" : "scan";
  const heading = prompt("");

  // --- Netz-Auswahl (gilt für Scanner und WoL) --------------------------------
  let options: NetOption[] = [];
  let selected: NetOption | undefined;
  const select = h("select", { class: "tselect", "aria-label": "Adapter und Subnetz" });
  const netInfo = h("span", {});
  const netPanel = panel(
    "NETZ",
    {},
    kvRow("Adapter", h("span", { class: "select-wrap" }, select)),
    kvRow("Subnetz", netInfo),
    h("p", { class: "note" }, tag("[!]", "err"), h("span", { class: "plain" }, " Nur im eigenen bzw. erlaubten Netz verwenden.")),
  );

  const buildOptions = () => {
    options = [];
    for (const a of state.adapters.filter((x) => x.connected)) {
      for (const e of a.ipv4.filter((x) => isIpv4(x.address))) {
        options.push({
          key: `${a.name}|${e.address}`,
          adapter: a.name,
          address: e.address,
          prefix: maskToPrefix(e.subnetMask),
          network: networkOf(e),
          blocked: scanBlockReason(e),
          gateway: ipv4Gateway(a),
        });
      }
    }
    // Gespeicherte Wahl, sonst primärer Adapter, sonst erstes scanbares Netz
    const saved = prefs.get("lanNet", "");
    const primary = primaryAdapter();
    selected =
      options.find((o) => o.key === (selected?.key ?? saved)) ??
      options.find((o) => o.adapter === primary?.name && !o.blocked) ??
      options.find((o) => !o.blocked) ??
      options[0];
    replaceChildren(
      select,
      ...(options.length
        ? options.map((o) =>
            h(
              "option",
              { value: o.key, selected: o.key === selected?.key },
              `${o.adapter} – ${o.address}${o.prefix !== null ? "/" + o.prefix : ""}${o.blocked ? `  (${o.blocked})` : ""}`,
            ),
          )
        : [h("option", { value: "" }, state.loading ? "lade …" : "kein verbundener Adapter mit IPv4")]),
    );
    renderNet();
  };

  const renderNet = () => {
    if (!selected) {
      replaceChildren(netInfo, h("span", { class: "dim" }, "–"));
    } else if (selected.blocked) {
      replaceChildren(netInfo, h("span", {}, selected.network ?? "?", " "), tag(`[GESPERRT] ${selected.blocked}`, "err"));
    } else {
      replaceChildren(
        netInfo,
        h("span", { class: "plain" }, selected.network ?? "?"),
        h("span", { class: "dim" }, ` · ${hostCount(selected.prefix ?? 32)} Adressen`),
      );
    }
    renderScanControls();
    renderHeading();
  };

  select.addEventListener("change", () => {
    selected = options.find((o) => o.key === select.value);
    if (selected) prefs.set("lanNet", selected.key);
    renderNet();
  });

  // --- Scanner ---------------------------------------------------------------
  const scanBtn = tbutton("Scan starten", { cls: "tbtn-wide" });
  const progressText = h("span", { class: "dim" }, "–");
  const progressBar = h("span", {});
  const scanPanel = panel(
    "SCAN",
    {},
    kvRow("Fortschritt", h("span", {}, progressBar, " ", progressText)),
    h(
      "p",
      { class: "dim wrap note" },
      "Methode: ARP-Anfrage an jede Adresse (64 parallel), dann Ping (500 ms) und Reverse-DNS für gefundene Geräte.",
    ),
    h("div", { class: "panel-actions" }, scanBtn),
  );

  const filterInput = h("input", {
    class: "tinput tinput-short",
    type: "text",
    spellcheck: "false",
    autocomplete: "off",
    placeholder: "IP, Name, MAC …",
    "aria-label": "Filter",
  });
  let sortKey: SortKey = "ip";
  const sortChoice = choice<SortKey>(
    [
      { value: "ip", label: "IP" },
      { value: "name", label: "Name" },
      { value: "latency", label: "Latenz" },
    ],
    sortKey,
    (v) => {
      sortKey = v;
      renderHosts();
    },
  );
  const hostsCount = h("span", { class: "dim" });
  const hostsBody = h("div", {});
  const hostsPanel = panel(
    "GERÄTE",
    { right: [hostsCount] },
    kvRow("Filter", h("span", { class: "input-wrap" }, h("span", { class: "dim" }, "> "), filterInput)),
    kvRow("Sortierung", sortChoice.el),
    h("div", { class: "spacer-line" }),
    hostsBody,
  );
  const scanView = h("div", { class: "stack" }, scanPanel.el, hostsPanel.el);

  let scanId = 0;
  let scanning = false;
  let cancelling = false;
  let scanNet: NetOption | undefined; // Netz des letzten Scans (für [DU]/[GATEWAY])
  let scanNetwork = "";
  const hosts = new Map<string, LanHost>();

  function renderScanControls(): void {
    scanBtn.textContent = cancelling ? "breche ab …" : scanning ? "Abbrechen" : "Scan starten";
    scanBtn.disabled = cancelling || (!scanning && (!selected || selected.blocked !== null));
    scanBtn.title = !scanning && selected?.blocked ? `Nicht erlaubt: ${selected.blocked}` : "";
  }

  function renderHeading(): void {
    heading.set(tab === "scan" ? `netconf lan-scan ${selected?.network ?? "<netz>"}` : "netconf wol");
  }

  const setProgress = (done: number, total: number) => {
    replaceChildren(progressBar, bar(total ? done / total : 0, 20));
    progressText.textContent = `${done}/${total}`;
    progressText.className = "plain";
  };

  function sortedHosts(): LanHost[] {
    const q = filterInput.value.trim().toLowerCase();
    const list = [...hosts.values()].filter(
      (x) => !q || [x.ip, x.mac, x.hostname ?? ""].some((f) => f.toLowerCase().includes(q)),
    );
    const byIp = (a: LanHost, b: LanHost) => compareIp(a.ip, b.ip);
    if (sortKey === "name") {
      list.sort((a, b) => (a.hostname ?? "￿").localeCompare(b.hostname ?? "￿", "de") || byIp(a, b));
    } else if (sortKey === "latency") {
      list.sort((a, b) => (a.latencyMs ?? 1e9) - (b.latencyMs ?? 1e9) || byIp(a, b));
    } else list.sort(byIp);
    return list;
  }

  function renderHosts(): void {
    const rows = sortedHosts();
    hostsCount.textContent = hosts.size ? `${rows.length} von ${hosts.size}` : "";
    if (hosts.size === 0) {
      replaceChildren(hostsBody, h("span", { class: "dim" }, scanning ? "suche …" : "noch kein Scan"));
      return;
    }
    replaceChildren(
      hostsBody,
      table(
        [
          { title: "IP", width: "15ch", cell: (x: LanHost) => copyable(x.ip) },
          {
            title: "Hostname",
            width: "minmax(10ch, 1fr)",
            // [DU]/[GATEWAY] vor dem Namen; lange Namen werden mit … gekürzt (ganzer Name im Tooltip)
            cell: (x) =>
              h(
                "span",
                { class: "clip", title: x.hostname ?? "" },
                x.ip === scanNet?.address ? tag("[DU] ", "plain") : null,
                x.ip === scanNet?.gateway ? tag("[GATEWAY] ", "plain") : null,
                x.hostname
                  ? copyable(x.hostname)
                  : h("span", { class: "dim" }, x.pending ? "…" : isRandomMac(x.mac) ? "– (zufällige MAC)" : "–"),
              ),
          },
          { title: "MAC", width: "18ch", cell: (x) => copyable(x.mac) },
          {
            title: "Latenz",
            width: "8ch",
            align: "right",
            cell: (x) =>
              x.pending
                ? h("span", { class: "dim" }, "…")
                : x.latencyMs === null
                  ? h("span", { class: "dim", title: "antwortet nicht auf Ping (ARP schon)" }, "–")
                  : x.latencyMs < 1
                    ? "<1 ms"
                    : `${x.latencyMs} ms`,
          },
          {
            title: "",
            width: "17ch",
            cell: (x) =>
              h(
                "span",
                { class: "row-actions" },
                tbutton("Ping", { title: `${x.ip} im Ping-Test anpingen`, onclick: () => pingHost(x.ip) }),
                tbutton("WoL", { title: "In die Wake-on-LAN-Liste übernehmen", onclick: () => void addWolFromScan(x) }),
              ),
          },
        ],
        rows,
        "keine Geräte für diesen Filter",
      ),
    );
  }

  async function startScan(): Promise<void> {
    if (scanning || !selected || selected.blocked) return;
    const net = selected;
    scanId = (Date.now() % 1_000_000) * 1000 + Math.floor(Math.random() * 1000);
    hosts.clear();
    scanNet = net;
    scanning = true;
    renderScanControls();
    renderHosts();
    setProgress(0, hostCount(net.prefix ?? 32));
    try {
      const started = await backend.lanScanStart(scanId, net.adapter, net.address);
      scanNetwork = started.network;
      setProgress(0, started.total);
      status(`LAN-Scan ${started.network} läuft …`);
    } catch (err) {
      scanning = false;
      renderScanControls();
      renderHosts();
      progressText.textContent = errorText(err);
      progressText.className = "tag-err";
      status(errorText(err), "error");
    }
  }

  async function cancelScan(): Promise<void> {
    if (!scanning || cancelling) return;
    cancelling = true;
    renderScanControls();
    await backend.lanScanCancel().catch(() => undefined);
  }

  events.lanHost.on((e) => {
    if (e.scanId !== scanId) return;
    hosts.set(e.host.ip, e.host);
    renderHosts();
  });
  events.lanProgress.on((e) => {
    if (e.scanId === scanId) setProgress(e.done, e.total);
  });
  events.lanFinished.on((e) => {
    if (e.scanId !== scanId) return;
    scanning = false;
    cancelling = false;
    renderScanControls();
    renderHosts();
    const secs = (e.elapsedMs / 1000).toFixed(1);
    const msg = e.cancelled
      ? `LAN-Scan abgebrochen – ${e.found} Geräte bis dahin`
      : `LAN-Scan ${scanNetwork}: ${e.found} Geräte gefunden (${secs} s)`;
    status(msg, e.cancelled ? "info" : "ok");
    if (e.cancelled) progressText.textContent += " (abgebrochen)";
    logToConsole(
      `netconf lan-scan ${scanNetwork}`,
      [
        ...sortedHosts().map(
          (x) => `${x.ip.padEnd(16)} ${x.mac}  ${(x.latencyMs === null ? "–" : x.latencyMs + " ms").padStart(7)}  ${x.hostname ?? ""}`,
        ),
        msg,
      ],
    );
  });

  scanBtn.addEventListener("click", () => void (scanning ? cancelScan() : startScan()));
  filterInput.addEventListener("input", renderHosts);

  // --- Wake-on-LAN -----------------------------------------------------------
  const newBtn = tbutton("Neues Gerät", { onclick: () => openForm(null) });
  const wolBody = h("div", {});
  const wolPanel = panel(
    "WAKE-ON-LAN",
    { right: [newBtn] },
    wolBody,
    h(
      "p",
      { class: "dim wrap note" },
      "Das Zielgerät muss Wake-on-LAN aktiviert haben (BIOS/UEFI und Netzwerkkarte). „Gesendet“ heisst nicht „aufgewacht“. " +
        "Das Magic Packet geht per Broadcast (UDP-Port 9) über den oben gewählten Adapter – nur ins eigene Netz. " +
        "Ist die IP bekannt, prüft Net-Conf danach 60 s lang per Ping, ob das Gerät aufwacht.",
    ),
  );

  // Formular (Neu / Ändern)
  const fName = h("input", { class: "tinput tinput-short", type: "text", maxlength: "40", spellcheck: "false", "aria-label": "Name" });
  const fMac = h("input", { class: "tinput tinput-short", type: "text", spellcheck: "false", placeholder: "AA-BB-CC-DD-EE-FF", "aria-label": "MAC-Adresse" });
  const fIp = h("input", { class: "tinput tinput-short", type: "text", spellcheck: "false", placeholder: "optional, für den Ping-Check", "aria-label": "IP-Adresse" });
  const fNote = h("input", { class: "tinput", type: "text", maxlength: "120", spellcheck: "false", placeholder: "optional", "aria-label": "Notiz" });
  const fMsg = h("span", { class: "dim" });
  const saveBtn = tbutton("Speichern");
  const formPanel = panel(
    "GERÄT",
    {},
    kvRow("Name", h("span", { class: "input-wrap" }, h("span", { class: "dim" }, "> "), fName)),
    kvRow("MAC-Adresse", h("span", { class: "input-wrap" }, h("span", { class: "dim" }, "> "), fMac)),
    kvRow("IP-Adresse", h("span", { class: "input-wrap" }, h("span", { class: "dim" }, "> "), fIp)),
    kvRow("Notiz", h("span", { class: "input-wrap" }, h("span", { class: "dim" }, "> "), fNote)),
    h("p", { class: "dim note" }, "MAC-Formate: AA-BB-CC-DD-EE-FF, AA:BB:CC:DD:EE:FF oder AABBCCDDEEFF"),
    h("div", { class: "panel-actions quick" }, saveBtn, tbutton("Abbrechen", { onclick: () => closeForm() }), fMsg),
  );
  formPanel.el.hidden = true;
  const wolView = h("div", { class: "stack" }, wolPanel.el, formPanel.el);

  /** Index des Geräts, das gerade bearbeitet wird (null = neues Gerät) */
  let editing: number | null = null;
  /** Rückmeldung pro MAC: "gesendet – prüfe 12/60 s", "online nach 23 s" … */
  const wake = new Map<string, { text: string; kind: "ok" | "err" | "plain" | "dim"; token: number }>();
  let wakeToken = 0;

  function renderWol(): void {
    const devices = config().wolDevices;
    replaceChildren(
      wolBody,
      table(
        [
          {
            title: "Name / Notiz",
            width: "minmax(10ch, 1fr)",
            cell: (d: WolDevice) =>
              h(
                "span",
                { class: "cell-lines", title: d.note || d.name },
                h("span", { class: "plain" }, d.name),
                d.note ? h("span", { class: "dim" }, d.note) : null,
              ),
          },
          {
            title: "MAC / IP",
            width: "18ch",
            cell: (d) =>
              h("span", { class: "cell-lines" }, copyable(d.mac), d.ip ? copyable(d.ip) : h("span", { class: "dim" }, "IP unbekannt")),
          },
          {
            title: "Status",
            width: "minmax(12ch, 1fr)",
            cell: (d) => {
              const w = wake.get(d.mac);
              return w ? tag(w.text, w.kind) : h("span", { class: "dim" }, "–");
            },
          },
          {
            title: "",
            width: "31ch",
            cell: (d) =>
              h(
                "span",
                { class: "row-actions" },
                tbutton("Aufwecken", { title: `Magic Packet an ${d.mac} senden`, onclick: () => void wakeDevice(d) }),
                tbutton("Ändern", { onclick: () => openForm(devices.indexOf(d)) }),
                tbutton("x", { title: "Löschen", onclick: () => void deleteDevice(d) }),
              ),
          },
        ],
        devices,
        "noch keine Geräte – [ Neues Gerät ] oder im Scanner bei einem Gerät [ WoL ] klicken",
      ),
    );
  }

  function openForm(index: number | null): void {
    editing = index;
    const d = index === null ? undefined : config().wolDevices[index];
    fName.value = d?.name ?? "";
    fMac.value = d?.mac ?? "";
    fIp.value = d?.ip ?? "";
    fNote.value = d?.note ?? "";
    fMsg.textContent = "";
    formPanel.title.textContent = d ? `GERÄT ÄNDERN: ${d.name}` : "NEUES GERÄT";
    formPanel.el.hidden = false;
    fName.focus();
  }

  function closeForm(): void {
    formPanel.el.hidden = true;
    editing = null;
  }

  async function saveForm(): Promise<void> {
    const fail = (msg: string) => {
      fMsg.textContent = msg;
      fMsg.className = "tag-err";
      status(msg, "error");
    };
    // Schnelle Prüfung im Frontend – verbindlich prüft das Backend (config.rs)
    if (!fName.value.trim()) return fail("Bitte einen Namen eingeben.");
    const mac = normalizeMac(fMac.value);
    if (!mac) return fail("Ungültige MAC-Adresse. Beispiel: AA-BB-CC-DD-EE-FF");
    const ip = fIp.value.trim();
    if (ip && !isIpv4(ip)) return fail("Die IP-Adresse muss eine IPv4-Adresse sein (z. B. 192.168.1.20).");
    const list = [...config().wolDevices];
    if (list.some((d, i) => d.mac === mac && i !== editing)) return fail(`Ein Gerät mit der MAC ${mac} gibt es schon.`);
    const device: WolDevice = { name: fName.value.trim(), mac, ip: ip || null, note: fNote.value.trim() };
    if (editing === null) list.push(device);
    else list[editing] = device;
    try {
      await updateConfig({ wolDevices: list });
      status(`gespeichert: ${device.name} (${mac})`, "ok");
      closeForm();
    } catch (err) {
      fail(errorText(err));
    }
  }

  async function deleteDevice(d: WolDevice): Promise<void> {
    const ok = await confirmDialog({
      title: "Gerät löschen",
      message: `„${d.name}“ (${d.mac}) aus der Wake-on-LAN-Liste löschen?`,
      confirmText: "Löschen",
    });
    if (!ok) return;
    try {
      await updateConfig({ wolDevices: config().wolDevices.filter((x) => x.mac !== d.mac) });
      wake.delete(d.mac);
      if (editing !== null) closeForm();
      status(`gelöscht: ${d.name}`);
    } catch (err) {
      status(errorText(err), "error");
    }
  }

  async function addWolFromScan(x: LanHost): Promise<void> {
    const list = [...config().wolDevices];
    const existing = list.findIndex((d) => d.mac === x.mac);
    // Nur der erste Teil des Namens ("nas-keller" statt "nas-keller.fritz.box")
    const name = (x.hostname?.split(".")[0] || x.ip).slice(0, 40);
    if (existing >= 0) {
      if (list[existing].ip === x.ip) return status(`${list[existing].name} ist schon in der WoL-Liste.`);
      list[existing] = { ...list[existing], ip: x.ip };
    } else {
      list.push({ name, mac: x.mac, ip: x.ip, note: "aus LAN-Scan" });
    }
    try {
      await updateConfig({ wolDevices: list });
      status(existing >= 0 ? `WoL-Liste: IP von ${list[existing].name} aktualisiert` : `zur WoL-Liste hinzugefügt: ${name} (${x.mac})`, "ok");
    } catch (err) {
      status(errorText(err), "error");
    }
  }

  async function wakeDevice(d: WolDevice): Promise<void> {
    if (!selected) return status("Bitte oben einen Adapter wählen.", "error");
    const token = ++wakeToken;
    const set = (text: string, kind: "ok" | "err" | "plain" | "dim") => {
      wake.set(d.mac, { text, kind, token });
      renderWol();
    };
    try {
      const r = await backend.wolSend(d.mac, selected.adapter, selected.address);
      status(`Magic Packet gesendet an ${d.name} (${r.mac})`, "ok");
      logToConsole(`netconf wol ${r.mac}`, [`Magic Packet gesendet an ${d.name} (${r.mac}) über "${selected.adapter}"`, ...r.sentTo.map((t) => `  → ${t}`)]);
    } catch (err) {
      set("[FEHLER]", "err");
      status(errorText(err), "error");
      return;
    }
    if (!d.ip) {
      set("gesendet (ohne IP kein Ping-Check)", "plain");
      return;
    }
    // Ping-Check: alle 2 s, max. 60 s. Ein neuer Klick (token) beendet den alten Check.
    const start = Date.now();
    const current = () => wake.get(d.mac)?.token === token;
    set("gesendet – prüfe …", "plain");
    while (Date.now() - start < 60_000) {
      const t0 = Date.now();
      let up = false;
      try {
        up = (await backend.icmpPing(d.ip, 1000)).status === "ok";
      } catch {
        up = false;
      }
      if (!current()) return;
      const secs = Math.round((Date.now() - start) / 1000);
      if (up) {
        set(`[ONLINE] nach ${secs} s`, "ok");
        status(`${d.name} ist online (nach ${secs} s)`, "ok");
        return;
      }
      set(`gesendet – prüfe ${secs}/60 s`, "plain");
      await new Promise((r) => setTimeout(r, Math.max(0, 2000 - (Date.now() - t0))));
      if (!current()) return;
    }
    set("keine Antwort nach 60 s", "err");
    status(`${d.name}: keine Antwort nach 60 s (WoL aktiviert? Gerät im selben Netz?)`, "error");
  }

  saveBtn.addEventListener("click", () => void saveForm());
  for (const el of [fName, fMac, fIp, fNote]) {
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void saveForm();
      if (e.key === "Escape") closeForm();
    });
  }

  // --- Reiter ------------------------------------------------------------------
  const show = (id: TabId) => {
    tab = id;
    scanView.hidden = id !== "scan";
    wolView.hidden = id !== "wol";
    tabBar.set(id);
    prefs.set("lanTab", id);
    renderHeading();
  };
  const TABS: { value: TabId; label: string }[] = [
    { value: "scan", label: "Scanner" },
    { value: "wol", label: "Wake-on-LAN" },
  ];
  const tabBar = tabs(TABS, tab, show);

  const el = h(
    "section",
    { class: "view", "data-view": "lan" },
    tabBar.el,
    h("div", { class: "subview" }, heading.el, h("div", { class: "stack" }, netPanel.el, scanView, wolView)),
  );

  onStateChange(buildOptions);
  onConfigChange(renderWol);
  buildOptions();
  renderHosts();
  renderWol();
  setProgress(0, 0);
  progressText.textContent = "–";
  progressText.className = "dim";
  show(tab);

  return {
    el,
    next: () => show(tab === "scan" ? "wol" : "scan"),
  };
}
