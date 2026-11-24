// Ansicht "Übersicht": ein Panel pro Netzwerkadapter, Zeilen wie bei ipconfig /all.
import { backend, errorText } from "../api";
import { onStateChange, setState, state, wifiFor } from "../state";
import type { AdapterInfo, WifiInfo } from "../types";
import { formatUnix, h, prefs, replaceChildren } from "../ui/dom";
import { status } from "../ui/statusbar";
import { bar, checkbox, copyable, kvRow, panel, prompt, tag, tbutton } from "../ui/widgets";

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
    publicIpPanel(),
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

/**
 * Öffentliche IP – wird NICHT automatisch abgefragt, sondern erst auf Klick,
 * weil dafür eine Anfrage an einen externen Dienst (ipify.org) nötig ist.
 */
function publicIpPanel(): HTMLElement {
  const v4 = h("span", { class: "dim" }, "–");
  const v6 = h("span", { class: "dim" }, "–");
  const btn = tbutton("Abfragen", { title: "Fragt ipify.org nach der öffentlichen IP" });
  const p = panel(
    "ÖFFENTLICHE IP",
    { cls: "public-ip", right: [btn] },
    kvRow("IPv4 (öffentlich)", v4),
    kvRow("IPv6 (öffentlich)", v6),
    h("p", { class: "dim" }, "Wird erst auf Klick abgefragt (Dienst: ipify.org)."),
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
      btn.textContent = "Erneut abfragen";
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

  const wifi = wifiFor(a);
  const p = panel(a.name || "(ohne Namen)", {
    cls: "adapter",
    right: [
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
