// Ansicht "WLAN" (F7): aktuelle Verbindung (live alle 2 s, mit Signal-Graph),
// Netze in der Umgebung, Kanal-Belegung, gespeicherte Profile und Verbinden.
//
// Der 2-s-Timer läuft NUR, solange die Seite offen ist (activate/deactivate
// aus main.ts).
//
// Sicherheit beim Verbinden (siehe CLAUDE.md):
// * Das Passwort steht nur im Eingabefeld und im einen Aufruf ans Backend.
//   Nach dem Absenden wird das Feld geleert und jede Referenz verworfen.
// * Es landet nie in der Konsole, der Statusleiste, im localStorage oder in config.json.
// * Das Feld zeigt das Passwort beim Tippen absichtlich an (type="text") –
//   so sieht man Tippfehler. spellcheck/autocomplete sind aus, damit der
//   Browser-Teil des WebViews nichts davon speichert oder prüft.
import { backend, errorText } from "../api";
import { logToConsole } from "../commands";
import { refreshAll, state } from "../state";
import type { WifiConnectRequest, WifiInfo, WifiNetwork, WifiProfile, WifiScanResult, WifiSecurity } from "../types";
import { h, prefs, replaceChildren } from "../ui/dom";
import { createLatencyGraph } from "../ui/latencygraph";
import { confirmDialog } from "../ui/modal";
import { status } from "../ui/statusbar";
import { copyable, hashBar, kvRow, panel, prompt, radio, table, tag, tbutton } from "../ui/widgets";
import {
  channelUsage,
  connectBlocked,
  NAMES_HIDDEN_HINT,
  passwordProblem,
  securityLabel,
  ssidLabel,
  ssidProblem,
} from "../wifiutil";

/** Aktualisierung der Verbindung */
const POLL_MS = 2000;
/** Signal-Graph: letzte Minute = 30 Messungen à 2 s */
const HISTORY = 30;
/** Nach WlanScan so lange warten, bis Windows die Liste aktualisiert hat */
const SCAN_WAIT_MS = 3500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sameId = (a: string, b: string) => a.toUpperCase() === b.toUpperCase();

/** Ziel des Verbinden-Formulars */
interface FormTarget {
  /** vorausgefüllt (bei versteckten Netzen leer und änderbar) */
  ssid: string;
  hidden: boolean;
  /** null = Net-Conf kann so nicht verbinden (802.1X, WEP …) */
  security: WifiSecurity | null;
  blocked: string | null;
  saved: boolean;
}

export interface WifiView {
  el: HTMLElement;
  activate(): void;
  deactivate(): void;
}

export function createWifi(): WifiView {
  let interfaces: WifiInfo[] = [];
  let loadError: string | null = null;
  let currentId = prefs.get("wifiIf", "");
  let current: WifiInfo | undefined;
  let history: (number | null)[] = [];
  let scan: WifiScanResult | null = null;
  let scanError: string | null = null;
  let profiles: WifiProfile[] = [];
  let profilesError: string | null = null;
  /** Für welches Interface Netze/Profile geladen sind ("" = neu laden) */
  let listsFor = "";
  let scanning = false;
  /** Verbinden/Trennen/Vergessen läuft */
  let busy = false;
  let gen = 0;
  let timer: number | undefined;

  const heading = prompt("netconf wlan");

  // --- VERBINDUNG -------------------------------------------------------------
  const ifSelect = h("select", { class: "tselect", "aria-label": "WLAN-Adapter" });
  const ifSelectWrap = h("span", { class: "select-wrap" }, ifSelect);
  const ifName = h("span", {});
  const connBody = h("div", {});
  const graph = createLatencyGraph({ unit: "%", nullLabel: "kein Signal", label: "Signalverlauf" });
  const graphRow = kvRow("Signal (1 min)", graph.el);
  const disconnectBtn = tbutton("Trennen", { title: "WLAN-Verbindung trennen", onclick: () => void disconnect() });
  const connActions = h("div", { class: "panel-actions quick" }, disconnectBtn, tag("[!]", "err"));
  const connPanel = panel("VERBINDUNG", {}, kvRow("Adapter", h("span", {}, ifSelectWrap, ifName)), connBody, graphRow, connActions);

  // --- NETZE IN DER UMGEBUNG ---------------------------------------------------
  const scanBtn = tbutton("Scannen", { title: "Nach WLAN-Netzen suchen (dauert ca. 4 s)", onclick: () => void doScan() });
  const hiddenBtn = tbutton("Verstecktes Netz …", { title: "Mit einem Netz verbinden, das seinen Namen nicht sendet", onclick: () => openForm(null) });
  const netCount = h("span", { class: "dim" });
  const netBody = h("div", {});
  const netPanel = panel(
    "NETZE IN DER UMGEBUNG",
    { right: [netCount] },
    h("div", { class: "toolbar" }, scanBtn, hiddenBtn, h("span", { class: "dim" }, "Klick auf ein Netz: verbinden")),
    netBody,
  );

  // --- VERBINDEN (Formular) ----------------------------------------------------
  let target: FormTarget | null = null;
  let formSecurity: WifiSecurity = "wpa2";
  const fSsid = h("input", {
    class: "tinput tinput-short",
    type: "text",
    spellcheck: "false",
    autocomplete: "off",
    placeholder: "Name des versteckten Netzes",
    "aria-label": "SSID",
  });
  // Absichtlich type="text": Das Passwort ist beim Tippen sichtbar (gewünscht).
  const fPass = h("input", {
    class: "tinput",
    type: "text",
    spellcheck: "false",
    autocomplete: "off",
    autocapitalize: "off",
    autocorrect: "off",
    "data-lpignore": "true",
    placeholder: "WLAN-Passwort (wird beim Tippen angezeigt)",
    "aria-label": "WLAN-Passwort",
  });
  const secCell = h("span", {});
  const secRadio = radio<WifiSecurity>(
    [
      { value: "wpa2", label: "WPA2" },
      { value: "wpa3", label: "WPA3" },
      { value: "open", label: "Offen" },
    ],
    formSecurity,
    (v) => {
      formSecurity = v;
      renderForm();
    },
  );
  const ssidRow = kvRow("SSID", h("span", { class: "input-wrap" }, h("span", { class: "dim" }, "> "), fSsid));
  const secRow = kvRow("Sicherheit", secCell);
  const passRow = kvRow("Passwort", h("span", { class: "input-wrap" }, h("span", { class: "dim" }, "> "), fPass));
  const formNote = h("div", {});
  const fMsg = h("span", { class: "dim" });
  const connectBtn = tbutton("Verbinden", { onclick: () => void submit() });
  const savedBtn = tbutton("Mit gespeichertem Profil verbinden", {
    onclick: () => target && void connectProfile(target.ssid, true),
  });
  const formPanel = panel(
    "VERBINDEN",
    {},
    ssidRow,
    secRow,
    passRow,
    formNote,
    h(
      "p",
      { class: "dim wrap note" },
      "Net-Conf legt ein normales Windows-WLAN-Profil an – wie beim Verbinden über Windows. " +
        "Das Passwort geht nur an Windows und wird nirgends sonst gespeichert oder protokolliert.",
    ),
    h("div", { class: "panel-actions quick" }, connectBtn, savedBtn, tbutton("Abbrechen", { onclick: () => closeForm() }), fMsg),
  );
  formPanel.el.hidden = true;

  // --- KANAL-BELEGUNG + PROFILE --------------------------------------------------
  const chanBody = h("div", {});
  const chanPanel = panel("KANAL-BELEGUNG", {}, chanBody);
  const profCount = h("span", { class: "dim" });
  const profBody = h("div", {});
  const profPanel = panel("GESPEICHERTE PROFILE", { right: [profCount] }, profBody);

  const el = h(
    "section",
    { class: "view", "data-view": "wifi" },
    heading.el,
    h("div", { class: "stack" }, connPanel.el, netPanel.el, formPanel.el, chanPanel.el, profPanel.el),
  );

  // --- Hilfen ------------------------------------------------------------------

  const adapterName = (w: WifiInfo) =>
    state.adapters.find((a) => sameId(a.id, w.interfaceId))?.name ?? "WLAN";

  /** Ist dieses Netz das aktuell verbundene? */
  const isConnected = (n: WifiNetwork) =>
    current?.connected && current.ssid ? !n.hidden && n.ssid === current.ssid : n.connected;

  // --- Daten laden -------------------------------------------------------------

  async function poll(): Promise<void> {
    try {
      interfaces = await backend.getWifi();
      loadError = null;
    } catch (err) {
      interfaces = [];
      loadError = errorText(err);
    }
    const next = interfaces.find((w) => sameId(w.interfaceId, currentId)) ?? interfaces[0];
    if (next?.interfaceId !== current?.interfaceId) history = [];
    current = next;
    if (current) currentId = current.interfaceId;
    const q = current?.connected && !current.error ? current.signalQuality : null;
    history.push(q);
    if (history.length > HISTORY) history = history.slice(-HISTORY);
    buildSelect();
    renderAll();
    if (current && listsFor !== current.interfaceId) void loadLists();
  }

  async function loadLists(): Promise<void> {
    if (!current) return;
    const id = current.interfaceId;
    listsFor = id;
    const [n, p] = await Promise.allSettled([backend.wifiNetworks(id), backend.wifiProfiles(id)]);
    if (!current || current.interfaceId !== id) return;
    scan = n.status === "fulfilled" ? n.value : null;
    scanError = n.status === "rejected" ? errorText(n.reason) : null;
    profiles = p.status === "fulfilled" ? p.value : [];
    profilesError = p.status === "rejected" ? errorText(p.reason) : null;
    renderAll();
  }

  /** Timer-Schleife: neue Runde erst, wenn die alte fertig ist (kein Stau) */
  async function loop(g: number): Promise<void> {
    if (g !== gen) return;
    await poll();
    if (g === gen) timer = window.setTimeout(() => void loop(g), POLL_MS);
  }

  /** Nach Verbinden/Trennen: alles neu laden, Adapter (IP) nach DHCP etwas später */
  async function afterChange(): Promise<void> {
    listsFor = "";
    await poll();
    setTimeout(() => void refreshAll(), 3000);
  }

  // --- Anzeige -----------------------------------------------------------------

  let selectKey = "";
  function buildSelect(): void {
    const key = interfaces.map((w) => `${w.interfaceId}|${w.connected}`).join(";") + `#${current?.interfaceId}`;
    ifSelectWrap.hidden = interfaces.length < 2;
    ifName.hidden = interfaces.length >= 2;
    if (current) {
      replaceChildren(ifName, h("span", { class: "plain" }, adapterName(current)), h("span", { class: "dim" }, ` · ${current.description}`));
    }
    if (key === selectKey) return; // nicht bei jedem Takt neu bauen (sonst klappt die Liste zu)
    selectKey = key;
    replaceChildren(
      ifSelect,
      ...interfaces.map((w) =>
        h(
          "option",
          { value: w.interfaceId, selected: w.interfaceId === current?.interfaceId },
          `${adapterName(w)} – ${w.description}${w.connected ? " (verbunden)" : ""}`,
        ),
      ),
    );
  }

  function renderAll(): void {
    const none = interfaces.length === 0;
    for (const p of [netPanel, chanPanel, profPanel]) p.el.hidden = none;
    if (none) formPanel.el.hidden = true;
    heading.set(current?.connected && current.ssid ? `netconf wlan "${current.ssid}"` : "netconf wlan");
    renderConn();
    renderNetworks();
    renderChannels();
    renderProfiles();
    renderForm();
  }

  function renderConn(): void {
    const w = current;
    graphRow.hidden = connActions.hidden = !w;
    if (!w) {
      replaceChildren(connPanel.right);
      replaceChildren(ifName, h("span", { class: "dim" }, "–"));
      replaceChildren(
        connBody,
        h(
          "p",
          { class: "wrap note" },
          loadError
            ? h("span", { class: "tag-err" }, loadError)
            : h("span", {}, "Kein WLAN-Adapter gefunden – oder der Dienst „WLAN-AutoKonfiguration“ läuft nicht. ", h("span", { class: "dim" }, "Kabelverbindungen stehen in der Übersicht (F1).")),
        ),
      );
      return;
    }
    replaceChildren(connPanel.right, w.connected ? tag("[VERBUNDEN]", "ok") : tag("[GETRENNT]", "dim"));
    const rows: HTMLElement[] = [];
    if (!w.connected) {
      rows.push(kvRow("Status", h("span", { class: "plain" }, w.state)));
    } else if (w.error) {
      rows.push(kvRow("Status", h("span", { class: "plain" }, w.state)));
      rows.push(kvRow("Hinweis", h("span", { class: "tag-err wrap" }, w.error)));
    } else {
      rows.push(kvRow("SSID", copyable(w.ssid)));
      rows.push(kvRow("BSSID", copyable(w.bssid)));
      if (w.signalQuality !== null) {
        rows.push(
          kvRow(
            "Signal",
            h(
              "span",
              {},
              hashBar(w.signalQuality / 100),
              ` ${w.signalQuality} %`,
              w.rssiDbm !== null ? h("span", { class: "dim" }, ` (${w.rssiDbm} dBm)`) : null,
            ),
          ),
        );
      }
      if (w.channel !== null) {
        rows.push(
          kvRow(
            "Kanal / Band",
            h("span", {}, `${w.channel} · ${w.band ?? "?"}`, w.frequencyMhz ? h("span", { class: "dim" }, ` (${w.frequencyMhz} MHz)`) : null),
          ),
        );
      }
      rows.push(kvRow("Funkstandard", w.phy || "–"));
      if (w.rxMbps !== null) rows.push(kvRow("Empfangsrate", `${w.rxMbps} Mbit/s`));
      if (w.txMbps !== null) rows.push(kvRow("Senderate", `${w.txMbps} Mbit/s`));
      rows.push(kvRow("Sicherheit", `${w.auth} / ${w.cipher}`));
    }
    replaceChildren(connBody, ...rows);
    disconnectBtn.disabled = busy || !w.connected;
    graph.render(history, 100);
  }

  function renderNetworks(): void {
    scanBtn.textContent = scanning ? "scanne …" : "Scannen";
    scanBtn.disabled = scanning || !current;
    if (scanError) {
      netCount.textContent = "";
      replaceChildren(netBody, h("p", { class: "tag-err wrap" }, scanError));
      return;
    }
    if (!scan) {
      netCount.textContent = "";
      replaceChildren(netBody, h("span", { class: "dim" }, "lade …"));
      return;
    }
    // Nach Signal sortiert (stärkstes oben)
    const list = [...scan.networks].sort((a, b) => b.signal - a.signal || a.ssid.localeCompare(b.ssid, "de"));
    netCount.textContent = list.length ? `${list.length} Netze` : "";
    const hint = scan.hint ?? (list.length === 0 || list.every((n) => n.hidden) ? NAMES_HIDDEN_HINT : null);
    replaceChildren(
      netBody,
      list.length
        ? h(
            "div",
            { class: "wifi-table" },
            table(
              [
                {
                  title: "SSID",
                  width: "minmax(12ch, 1fr)",
                  cell: (n: WifiNetwork) =>
                    h(
                      "button",
                      {
                        class: n.hidden ? "pick hidden-ssid" : "pick",
                        type: "button",
                        title: n.hidden ? "Verstecktes Netz – SSID beim Verbinden eingeben" : `Mit „${n.ssid}“ verbinden …`,
                        onclick: () => openForm(n),
                      },
                      ssidLabel(n),
                    ),
                },
                {
                  title: "Signal",
                  width: "18ch",
                  cell: (n) => h("span", { class: "hbar" }, hashBar(n.signal / 100), ` ${String(n.signal).padStart(3)} %`),
                },
                { title: "Kanal", width: "5ch", align: "right", cell: (n) => (n.channel !== null ? String(n.channel) : "–") },
                { title: "Band", width: "7ch", cell: (n) => n.band ?? "–" },
                {
                  title: "Sicherheit",
                  width: "10ch",
                  // Unverschlüsselt/veraltet als Warnwort (rote Schrift)
                  cell: (n) => tag(n.security, ["OFFEN", "WEP", "WPA"].includes(n.security) ? "err" : "plain"),
                },
                { title: "AP", width: "3ch", align: "right", cell: (n) => String(n.apCount) },
                {
                  title: "",
                  width: "13ch",
                  cell: (n) => (isConnected(n) ? tag("[VERBUNDEN]", "ok") : n.saved ? tag("[GESPEICHERT]", "plain") : ""),
                },
              ],
              list,
            ),
          )
        : null,
      hint ? h("p", { class: "wrap note" }, tag("[HINWEIS]", "plain"), " ", h("span", { class: "dim" }, hint)) : null,
    );
  }

  function renderChannels(): void {
    const own = current?.connected ? { channel: current.channel, band: current.band } : null;
    const bss = scan?.bss ?? [];
    if (bss.length === 0) {
      replaceChildren(chanBody, h("span", { class: "dim" }, scan ? "keine Access Points bekannt – [ Scannen ]" : "lade …"));
      return;
    }
    const usage = channelUsage(bss, own);
    const max = Math.max(1, ...usage.flatMap((u) => u.rows.map((r) => r.aps)));
    const parts: HTMLElement[] = [];
    for (const u of usage) {
      parts.push(h("div", { class: "band-head" }, u.band));
      parts.push(
        h(
          "div",
          { class: "chan-table" },
          table(
            [
              { title: "Kanal", width: "5ch", align: "right", cell: (r) => String(r.channel) },
              { title: "Belegung", width: "22ch", cell: (r) => hashBar(r.aps / max, 20) },
              { title: "AP", width: "3ch", align: "right", cell: (r) => (r.aps ? String(r.aps) : h("span", { class: "dim" }, "–")) },
              { title: "Netze", width: "5ch", align: "right", cell: (r) => (r.networks.length ? String(r.networks.length) : h("span", { class: "dim" }, "–")) },
              {
                title: "SSIDs",
                width: "minmax(0, 1fr)",
                cell: (r) =>
                  h(
                    "span",
                    { class: "ellipsis", title: r.networks.join(", ") },
                    r.own ? tag("[EIGENER] ", "plain") : null,
                    h("span", { class: "dim" }, r.networks.join(", ")),
                  ),
              },
            ],
            u.rows,
          ),
        ),
      );
    }
    parts.push(h("p", { class: "dim wrap note" }, "2,4 GHz: Nur die Kanäle 1, 6 und 11 überlappen sich nicht. Weniger belegte Kanäle = weniger Störungen."));
    replaceChildren(chanBody, ...parts);
  }

  function renderProfiles(): void {
    if (profilesError) {
      profCount.textContent = "";
      replaceChildren(profBody, h("p", { class: "tag-err wrap" }, profilesError));
      return;
    }
    profCount.textContent = profiles.length ? `${profiles.length}` : "";
    const inRange = new Set((scan?.networks ?? []).map((n) => n.ssid));
    const activeProfile = current?.connected ? current.profile || current.ssid : "";
    replaceChildren(
      profBody,
      h(
        "div",
        { class: "wifi-table" },
        table(
          [
            { title: "Profil", width: "minmax(12ch, 1fr)", cell: (p: WifiProfile) => h("span", { class: "ellipsis plain", title: p.name }, p.name) },
            {
              title: "Gilt für",
              width: "14ch",
              cell: (p) => (p.groupPolicy ? tag("[GPO]", "plain") : h("span", { class: "dim" }, p.perUser ? "nur mich" : "alle Benutzer")),
            },
            {
              title: "",
              width: "13ch",
              cell: (p) =>
                p.name === activeProfile ? tag("[VERBUNDEN]", "ok") : inRange.has(p.name) ? h("span", { class: "dim" }, "in Reichweite") : "",
            },
            {
              title: "",
              width: "31ch",
              cell: (p) => {
                const connect = tbutton("Verbinden", { onclick: () => void connectProfile(p.name, false) });
                connect.disabled = busy || p.name === activeProfile;
                const forgetBtn = tbutton("Vergessen", {
                  title: p.groupPolicy ? "Profile aus einer Gruppenrichtlinie lassen sich nicht löschen" : "Profil samt Passwort aus Windows löschen",
                  onclick: () => void forget(p),
                });
                forgetBtn.disabled = busy || p.groupPolicy;
                return h("span", { class: "row-actions" }, connect, forgetBtn, tag("[!]", "err"));
              },
            },
          ],
          profiles,
          "keine gespeicherten WLAN-Profile",
        ),
      ),
    );
  }

  // --- Formular ----------------------------------------------------------------

  function openForm(n: WifiNetwork | null): void {
    if (!current) return;
    if (n && !n.hidden) {
      target = { ssid: n.ssid, hidden: false, security: n.connectAs, blocked: connectBlocked(n), saved: n.saved };
    } else {
      // Verstecktes Netz: SSID eintippen, Sicherheit wählen (Vorschlag aus der Liste)
      target = { ssid: "", hidden: true, security: null, blocked: n ? connectBlocked(n) : null, saved: false };
      formSecurity = n?.connectAs ?? "wpa2";
      secRadio.querySelectorAll<HTMLButtonElement>("[role=radio]").forEach((b, i) => {
        if (["wpa2", "wpa3", "open"][i] === formSecurity) b.click();
      });
    }
    fSsid.value = target.ssid;
    fPass.value = "";
    fMsg.textContent = "";
    fMsg.className = "dim";
    formPanel.el.hidden = false;
    renderForm();
    formPanel.el.scrollIntoView({ block: "nearest" });
    const focus = target.hidden ? fSsid : fPass;
    if (!target.blocked) focus.focus();
  }

  function closeForm(): void {
    fPass.value = ""; // Passwort nie im Feld liegen lassen
    target = null;
    formPanel.el.hidden = true;
  }

  function effectiveSecurity(): WifiSecurity | null {
    if (!target) return null;
    return target.hidden ? formSecurity : target.security;
  }

  function renderForm(): void {
    if (!target) return;
    const sec = effectiveSecurity();
    formPanel.title.textContent = target.hidden ? "VERBINDEN: VERSTECKTES NETZ" : `VERBINDEN: ${target.ssid}`;
    fSsid.readOnly = !target.hidden;
    fSsid.classList.toggle("dim", !target.hidden);
    replaceChildren(secCell, target.hidden ? secRadio : h("span", { class: "plain" }, sec ? securityLabel(sec) : "nicht unterstützt"));
    const blocked = target.blocked && !target.hidden ? target.blocked : null;
    passRow.hidden = !!blocked || sec === "open";
    connectBtn.hidden = !!blocked;
    savedBtn.hidden = !target.saved;
    connectBtn.disabled = savedBtn.disabled = busy;
    fSsid.disabled = fPass.disabled = busy;
    const notes: HTMLElement[] = [];
    if (blocked) notes.push(h("p", { class: "note wrap" }, h("span", { class: "tag-err" }, blocked)));
    if (target.saved && !blocked) {
      notes.push(
        h(
          "p",
          { class: "note wrap" },
          tag("[GESPEICHERT]", "plain"),
          h("span", { class: "dim" }, " Für dieses Netz gibt es schon ein Profil. Mit neuem Passwort wird es ersetzt – scheitert die Verbindung, bleibt das alte."),
        ),
      );
    }
    if (sec === "open" && !blocked) {
      notes.push(h("p", { class: "note wrap" }, tag("[!]", "err"), h("span", { class: "dim" }, " Offenes Netz: Daten gehen unverschlüsselt durch die Luft.")));
    }
    replaceChildren(formNote, ...notes);
  }

  async function submit(): Promise<void> {
    if (busy || !current || !target || target.blocked) return;
    const sec = effectiveSecurity();
    if (!sec) return;
    const ssid = target.hidden ? fSsid.value : target.ssid;
    const fail = (msg: string) => {
      fMsg.textContent = msg;
      fMsg.className = "tag-err";
      status(msg, "error");
    };
    // Schnelle Prüfung (Komfort) – verbindlich prüft das Backend. Meldungen ohne Passwort.
    const problem = ssidProblem(ssid) ?? passwordProblem(sec, sec === "open" ? "" : fPass.value);
    if (problem) return fail(problem);

    // Passwort aus dem Feld holen und das Feld SOFORT leeren (nach dem Absenden
    // soll es nirgends mehr stehen). JS-Strings lassen sich nicht überschreiben –
    // wir verwerfen darum jede Referenz, sobald der Aufruf raus ist.
    const req: WifiConnectRequest = {
      interfaceId: current.interfaceId,
      ssid,
      password: sec === "open" ? "" : fPass.value,
      security: sec,
      hidden: target.hidden,
    };
    fPass.value = "";
    busy = true;
    fMsg.textContent = "verbinde … (bis 30 s)";
    fMsg.className = "dim";
    renderAll();
    status(`verbinde mit „${ssid}“ …`);
    let ok = false;
    let message: string;
    try {
      const pending = backend.wifiConnect(req);
      req.password = ""; // Aufruf ist unterwegs → Referenz verwerfen
      message = await pending;
      ok = true;
    } catch (err) {
      message = errorText(err);
    } finally {
      req.password = "";
      busy = false;
    }
    // Protokoll ohne Passwort: nur SSID und Ergebnis
    logToConsole(`netconf wlan connect "${ssid}"`, [message], ok ? 0 : 1);
    if (ok) {
      status(message, "ok");
      closeForm();
      await afterChange();
    } else {
      renderAll();
      fail(message);
    }
  }

  // --- Aktionen ----------------------------------------------------------------

  async function connectProfile(name: string, fromForm: boolean): Promise<void> {
    if (busy || !current) return;
    busy = true;
    if (fromForm) {
      fMsg.textContent = "verbinde … (bis 30 s)";
      fMsg.className = "dim";
    }
    renderAll();
    status(`verbinde mit „${name}“ …`);
    try {
      const msg = await backend.wifiConnectProfile(current.interfaceId, name);
      busy = false;
      status(msg, "ok");
      logToConsole(`netconf wlan connect profile="${name}"`, [msg]);
      if (fromForm) closeForm();
      await afterChange();
    } catch (err) {
      busy = false;
      const msg = errorText(err);
      status(msg, "error");
      logToConsole(`netconf wlan connect profile="${name}"`, [msg], 1);
      if (fromForm) {
        fMsg.textContent = msg;
        fMsg.className = "tag-err";
      }
      renderAll();
    }
  }

  async function disconnect(): Promise<void> {
    if (busy || !current?.connected) return;
    const ok = await confirmDialog({
      title: "WLAN trennen",
      message: `Die WLAN-Verbindung${current.ssid ? ` zu „${current.ssid}“` : ""} wird getrennt. Windows verbindet sich danach evtl. automatisch mit einem anderen bekannten Netz.`,
      confirmText: "Trennen",
      danger: true,
    });
    if (!ok || !current) return;
    busy = true;
    renderAll();
    try {
      await backend.wifiDisconnect(current.interfaceId);
      status("WLAN getrennt", "ok");
      logToConsole("netconf wlan disconnect", ["WLAN-Verbindung getrennt"]);
    } catch (err) {
      status(errorText(err), "error");
    } finally {
      busy = false;
    }
    await afterChange();
  }

  async function forget(p: WifiProfile): Promise<void> {
    if (busy || !current || p.groupPolicy) return;
    const active = current.connected && (current.profile || current.ssid) === p.name;
    const ok = await confirmDialog({
      title: "WLAN-Profil vergessen",
      message: `Das Windows-Profil „${p.name}“ wird gelöscht – samt gespeichertem Passwort.${active ? " Die aktuelle Verbindung wird dabei getrennt." : ""}`,
      confirmText: "Vergessen",
      danger: true,
    });
    if (!ok || !current) return;
    busy = true;
    renderAll();
    try {
      await backend.wifiForget(current.interfaceId, p.name);
      status(`Profil vergessen: ${p.name}`, "ok");
      logToConsole(`netconf wlan forget "${p.name}"`, ["Profil gelöscht"]);
    } catch (err) {
      status(errorText(err), "error");
    } finally {
      busy = false;
    }
    await afterChange();
  }

  async function doScan(): Promise<void> {
    if (!current || scanning) return;
    const id = current.interfaceId;
    scanning = true;
    renderNetworks();
    try {
      await backend.wifiScan(id);
      status("WLAN-Scan läuft …");
      await sleep(SCAN_WAIT_MS); // Windows braucht ein paar Sekunden für die neue Liste
      listsFor = "";
      await loadLists();
      const nets = scan?.networks ?? [];
      status(`WLAN-Scan: ${nets.length} Netze gefunden`, "ok");
      logToConsole("netconf wlan scan", [
        ...nets.map(
          (n) =>
            `${ssidLabel(n).padEnd(33)} ${String(n.signal).padStart(3)} %  Kanal ${String(n.channel ?? "?").padStart(3)}  ${(n.band ?? "").padEnd(7)}  ${n.security}`,
        ),
        `${nets.length} Netze`,
      ]);
    } catch (err) {
      status(errorText(err), "error");
    } finally {
      scanning = false;
      renderNetworks();
    }
  }

  // --- Ereignisse --------------------------------------------------------------

  ifSelect.addEventListener("change", () => {
    currentId = ifSelect.value;
    prefs.set("wifiIf", currentId);
    history = [];
    listsFor = "";
    scan = null;
    closeForm();
    void poll();
  });
  for (const input of [fSsid, fPass]) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void submit();
      if (e.key === "Escape") closeForm();
    });
  }

  renderAll();
  return {
    el,
    activate: () => {
      const g = ++gen;
      listsFor = ""; // Netze/Profile beim Öffnen frisch laden
      void loop(g);
    },
    deactivate: () => {
      gen++;
      window.clearTimeout(timer);
      closeForm(); // Passwortfeld leeren, wenn man die Seite verlässt
    },
  };
}
