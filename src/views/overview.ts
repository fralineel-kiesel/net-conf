// Ansicht "Übersicht": ASCII-Titel, Schnellüberblick (SYSTEM), öffentliche IP
// und ein Panel pro Netzwerkadapter mit Zeilen wie bei ipconfig /all.
import titleArt from "../../assets/title.txt?raw";
import { backend, errorText } from "../api";
import { onStateChange, primaryAdapter, setState, sortedAdapters, state, wifiFor } from "../state";
import type { AdapterInfo, WifiInfo } from "../types";
import { formatUnix, h, prefs, replaceChildren } from "../ui/dom";
import { status } from "../ui/statusbar";
import { bar, checkbox, copyable, kvRow, panel, prompt, tag, tbutton } from "../ui/widgets";

/** Der ASCII-Titel genau wie in assets/title.txt (ein evtl. \r von Windows-Git weg). */
export const TITLE_ART = titleArt.replace(/\r/g, "").replace(/\n+$/, "");

export function createOverview(): HTMLElement {
  const grid = h("div", { class: "panel-grid" });
  const hideBox = checkbox("Getrennte Adapter ausblenden", state.hideDisconnected, (v) => {
    prefs.set("hideDisconnected", v ? "1" : "0");
    setState({ hideDisconnected: v });
  });

  // Titel: textContent (nicht innerHTML) – so bleiben \ / _ | exakt erhalten.
  const art = h("pre", { class: "ascii-title", "aria-label": "NET-CONF" });
  art.textContent = TITLE_ART;
  const system = systemPanel();

  const view = h(
    "section",
    { class: "view overview", "data-view": "overview" },
    h(
      "header",
      { class: "title-block" },
      art,
      // Ersatz für schmale Fenster (umschalten per CSS-Container-Query)
      h("div", { class: "title-compact bright" }, "[ NET-CONF ]"),
      h("p", { class: "dim" }, `Netzwerk-Werkzeug für Windows 11 · v${__APP_VERSION__}`),
    ),
    h("div", { class: "top-grid" }, system.el, publicIpPanel()),
    h("div", { class: "section-head" }, prompt("ipconfig /all").el),
    h("div", { class: "toolbar" }, hideBox, h("span", { class: "dim" }, "Klick auf einen Wert kopiert ihn.")),
    grid,
  );

  const render = () => {
    system.render();
    if (state.loading && state.adapters.length === 0) {
      replaceChildren(grid, h("p", { class: "dim" }, "lade Adapter …"));
      return;
    }
    if (state.error) {
      replaceChildren(grid, h("p", { class: "tag-err" }, "Die Adapter konnten nicht gelesen werden: ", state.error));
      return;
    }
    const visible = sortedAdapters(state.adapters).filter((a) => !state.hideDisconnected || a.connected);
    if (visible.length === 0) {
      replaceChildren(
        grid,
        h("p", { class: "dim" }, state.hideDisconnected ? "Keine verbundenen Adapter gefunden." : "Keine Adapter gefunden."),
      );
      return;
    }
    const primary = primaryAdapter();
    replaceChildren(grid, ...visible.map((a) => adapterPanel(a, a.id === primary?.id)));
  };

  onStateChange(render);
  render();
  return view;
}

/** Subnetzmaske → Präfixlänge, z. B. 255.255.255.0 → 24 */
function maskToPrefix(mask: string): number | null {
  const parts = mask.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !(p >= 0 && p <= 255))) return null;
  return parts.reduce((n, p) => n + p.toString(2).split("").filter((b) => b === "1").length, 0);
}

/** Schnellüberblick: Hostname, DNS-Suffix und der primäre Adapter (mit Gateway). */
function systemPanel(): { el: HTMLElement; render(): void } {
  const p = panel("SYSTEM", {});
  const render = () => {
    const a = primaryAdapter();
    replaceChildren(p.right, a ? tag("[ONLINE]", "ok") : tag("[KEIN GATEWAY]", "err"));
    const dimDash = () => h("span", { class: "dim" }, "—");
    const rows: HTMLElement[] = [kvRow("Hostname", state.hostname ? copyable(state.hostname) : dimDash())];
    if (!a) {
      rows.push(kvRow("DNS-Suffix", dimDash()));
      rows.push(
        kvRow(
          "Primärer Adapter",
          h("span", { class: "tag-err wrap" }, state.loading ? "lade …" : "keiner mit Standardgateway – kein Netzwerk?"),
        ),
      );
      replaceChildren(p.body, ...rows);
      return;
    }
    const wifi = wifiFor(a);
    rows.push(kvRow("DNS-Suffix", a.dnsSuffix ? copyable(a.dnsSuffix) : dimDash()));
    rows.push(
      kvRow(
        "Primärer Adapter",
        h(
          "span",
          {},
          h("span", { class: "plain" }, a.name),
          wifi?.connected && wifi.ssid ? h("span", { class: "dim" }, ` (${wifi.ssid})`) : null,
        ),
      ),
    );
    const v4 = a.ipv4.map((x) => {
      const prefix = maskToPrefix(x.subnetMask);
      return h("span", {}, copyable(x.address), prefix !== null ? h("span", { class: "dim" }, ` /${prefix}`) : null);
    });
    rows.push(kvRow("IPv4-Adresse", ...(v4.length ? v4 : [dimDash()])));
    rows.push(kvRow("Standardgateway", ...a.gateways.map((g) => copyable(g))));
    rows.push(kvRow("DNS-Server", ...(a.dnsServers.length ? a.dnsServers.map((d) => copyable(d)) : [dimDash()])));
    replaceChildren(p.body, ...rows);
  };
  return { el: p.el, render };
}

/**
 * Öffentliche IP – wird NICHT automatisch abgefragt, sondern erst auf Klick,
 * weil dafür eine Anfrage an einen externen Dienst (ipify.org) nötig ist.
 */
function publicIpPanel(): HTMLElement {
  const v4 = h("span", { class: "dim" }, "–");
  const v6 = h("span", { class: "dim" }, "–");
  const btn = tbutton("Abfragen", { title: "Fragt ipify.org nach der öffentlichen IP (nur auf Klick)" });
  const p = panel(
    "ÖFFENTLICHE IP",
    { cls: "public-ip kv-compact", right: [btn] },
    kvRow("IPv4", v4),
    kvRow("IPv6", v6),
    h("p", { class: "dim" }, "nur auf Klick (ipify.org)"),
  );
  btn.addEventListener("click", async () => {
    btn.textContent = "frage …";
    btn.disabled = true;
    try {
      const ip = await backend.getPublicIp();
      replaceChildren(v4, ip.ipv4 ? copyable(ip.ipv4) : h("span", { class: "dim" }, "keine"));
      replaceChildren(v6, ip.ipv6 ? copyable(ip.ipv6) : h("span", { class: "dim" }, "keine (kein IPv6-Internet)"));
      v4.className = v6.className = "";
      status(`öffentliche IP: ${ip.ipv4 ?? ip.ipv6}`, "ok");
    } catch (err) {
      const msg = errorText(err);
      v4.textContent = msg;
      v4.className = "tag-err";
      status(msg, "error");
    } finally {
      btn.textContent = "Erneut";
      btn.disabled = false;
    }
  });
  return p.el;
}

/** Zusätzliche Zeilen für WLAN-Adapter. */
function wifiRows(w: WifiInfo): HTMLElement[] {
  if (w.error) return [kvRow("WLAN", h("span", { class: "tag-err wrap" }, w.error))];
  if (!w.connected) return [kvRow("WLAN", h("span", { class: "dim" }, w.state))];
  const rows: HTMLElement[] = [kvRow("SSID", copyable(w.ssid))];
  if (w.signalQuality !== null) {
    rows.push(
      kvRow(
        "Signal",
        h(
          "span",
          {},
          bar(w.signalQuality / 100, 10),
          ` ${w.signalQuality} %`,
          w.rssiDbm !== null ? h("span", { class: "dim" }, ` (${w.rssiDbm} dBm)`) : null,
        ),
      ),
    );
  }
  const band = [w.band, w.frequencyMhz ? `${w.frequencyMhz} MHz` : null].filter(Boolean).join(", ");
  if (w.channel !== null) rows.push(kvRow("Kanal", `${w.channel}${band ? ` (${band})` : ""}`));
  rows.push(kvRow("Standard", w.phy));
  rows.push(kvRow("Sicherheit", `${w.auth} / ${w.cipher}`));
  if (w.rxMbps !== null && w.txMbps !== null) {
    rows.push(kvRow("Datenrate", `↓ ${Math.round(w.rxMbps)} / ↑ ${Math.round(w.txMbps)} Mbit/s`));
  }
  rows.push(kvRow("BSSID", copyable(w.bssid)));
  return rows;
}

function adapterPanel(a: AdapterInfo, primary: boolean): HTMLElement {
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

  const wifi = wifiFor(a);
  const p = panel(a.name || "(ohne Namen)", {
    cls: primary ? "adapter primary" : "adapter",
    right: [
      primary ? tag("[PRIMÄR]", "plain") : null,
      a.connected ? tag("[ONLINE]", "ok") : tag("[OFFLINE]", "dim"),
      wifi ? tag("[WLAN]") : null,
      tag(a.dhcpEnabled ? "[DHCP]" : "[STATISCH]"),
    ],
  });
  p.title.title = a.name;
  p.body.append(h("p", { class: "dim desc", title: a.description }, a.description));
  p.body.append(kvRow("DHCP aktiviert", h("span", { class: "plain" }, a.dhcpEnabled ? "Ja" : "Nein")));
  for (const [label, values, always] of rows) {
    if (values.length === 0 && !always) continue;
    p.body.append(kvRow(label, ...(values.length ? values.map((v) => copyable(v)) : [h("span", { class: "dim" }, "—")])));
  }
  if (wifi) {
    p.body.append(h("div", { class: "spacer-line" }), ...wifiRows(wifi));
  }
  return p.el;
}
