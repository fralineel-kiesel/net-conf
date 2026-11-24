// Tests → Port: TCP-Ports auf einem Host prüfen (offen / geschlossen / gefiltert).
import { backend, errorText } from "../../api";
import { logToConsole } from "../../commands";
import type { PortResult, PortTestResponse } from "../../types";
import { h, replaceChildren } from "../../ui/dom";
import { status } from "../../ui/statusbar";
import { copyable, kvRow, panel, prompt, radio, table, tag, tbutton } from "../../ui/widgets";
import { validateTarget } from "../../validate";

const MAX_PORTS = 32;

/** Bekannte Dienste – nur zur Anzeige. */
const SERVICES: Record<number, string> = {
  20: "FTP-Daten", 21: "FTP", 22: "SSH", 23: "Telnet", 25: "SMTP", 53: "DNS", 80: "HTTP",
  88: "Kerberos", 110: "POP3", 123: "NTP", 135: "RPC", 139: "NetBIOS", 143: "IMAP",
  389: "LDAP", 443: "HTTPS", 445: "SMB", 465: "SMTPS", 587: "SMTP-Submission",
  636: "LDAPS", 993: "IMAPS", 995: "POP3S", 1433: "MS-SQL", 1521: "Oracle",
  3306: "MySQL", 3389: "RDP", 5432: "PostgreSQL", 5900: "VNC", 5985: "WinRM",
  5986: "WinRM (HTTPS)", 8080: "HTTP (alt.)", 8443: "HTTPS (alt.)",
};

const PRESETS: { label: string; ports: string }[] = [
  { label: "Web", ports: "80, 443" },
  { label: "RDP", ports: "3389" },
  { label: "SSH", ports: "22" },
  { label: "SMB", ports: "445" },
  { label: "DNS", ports: "53" },
  { label: "Mail", ports: "25, 465, 587, 993" },
  { label: "AD", ports: "53, 88, 389, 445, 636" },
];

/** "80, 443 8080-8082" → [80, 443, 8080, 8081, 8082] oder Fehlermeldung. */
export function parsePorts(text: string): number[] | string {
  const out = new Set<number>();
  for (const part of text.split(/[\s,;]+/).filter(Boolean)) {
    const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(part);
    if (!m) return `„${part}“ ist kein gültiger Port. Beispiel: 80, 443, 8080-8085`;
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : from;
    if (from < 1 || to > 65535 || from > to) return `Ungültiger Port/Bereich „${part}“ (erlaubt: 1–65535).`;
    for (let p = from; p <= to; p++) {
      out.add(p);
      if (out.size > MAX_PORTS) return `Bitte höchstens ${MAX_PORTS} Ports auf einmal testen.`;
    }
  }
  if (out.size === 0) return "Bitte mindestens einen Port angeben.";
  return [...out].sort((a, b) => a - b);
}

export function createPort(): HTMLElement {
  const heading = prompt("");
  const hostInput = h("input", {
    class: "tinput",
    type: "text",
    value: "google.com",
    spellcheck: "false",
    autocomplete: "off",
    placeholder: "IP-Adresse oder Hostname",
    "aria-label": "Host",
  });
  const portsInput = h("input", {
    class: "tinput tinput-short",
    type: "text",
    value: "80, 443",
    spellcheck: "false",
    autocomplete: "off",
    placeholder: "z. B. 80, 443, 8080-8085",
    "aria-label": "Ports",
  });
  let timeoutMs = 2000;
  const timeoutRadio = radio(
    [
      { value: "1000", label: "1 s" },
      { value: "2000", label: "2 s" },
      { value: "5000", label: "5 s", title: "Für langsame Verbindungen (VPN, Mobilfunk)" },
    ],
    "2000",
    (v) => (timeoutMs = Number(v)),
  );
  const presets = h(
    "span",
    { class: "quick" },
    ...PRESETS.map((p) =>
      tbutton(p.label, {
        title: p.ports,
        onclick: () => {
          portsInput.value = p.ports;
          updateHeading();
        },
      }),
    ),
  );
  const testBtn = tbutton("Testen");
  const resultBody = h("div", {}, h("span", { class: "dim" }, "noch kein Test"));

  const formPanel = panel(
    "PORT-TEST",
    {},
    kvRow("Host", h("span", { class: "input-wrap" }, h("span", { class: "dim" }, "> "), hostInput)),
    kvRow("Ports", h("span", { class: "input-wrap" }, h("span", { class: "dim" }, "> "), portsInput)),
    kvRow("Schnellwahl", presets),
    kvRow("Wartezeit", timeoutRadio),
    h("div", { class: "panel-actions" }, testBtn),
  );
  const resultPanel = panel("ERGEBNIS", {}, resultBody);
  const view = h("div", { class: "subview" }, heading.el, h("div", { class: "stack" }, formPanel.el, resultPanel.el));

  let busy = false;

  function updateHeading(): void {
    const ports = portsInput.value.replace(/\s+/g, "") || "<ports>";
    heading.set(`porttest ${hostInput.value.trim() || "<host>"} ${ports}`);
  }

  const statusTag = (r: PortResult) => {
    switch (r.status) {
      case "open":
        return h("span", {}, tag("[OFFEN]", "ok"));
      case "closed":
        return h("span", {}, tag("[GESCHLOSSEN]", "err"), h("span", { class: "dim" }, " Host antwortet, aber dort lauscht nichts"));
      case "filtered":
        return h("span", {}, tag("[GEFILTERT]", "err"), h("span", { class: "dim" }, " keine Antwort – vermutlich Firewall"));
      default:
        return h("span", {}, tag("[FEHLER]", "err"), h("span", { class: "dim" }, ` ${r.message ?? ""}`));
    }
  };

  const renderResult = (r: PortTestResponse) => {
    const open = r.results.filter((x) => x.status === "open").length;
    replaceChildren(
      resultBody,
      kvRow("Host", r.host),
      kvRow("Adresse", copyable(r.address)),
      kvRow("Zusammenfassung", h("span", {}, tag(`${open} von ${r.results.length} offen`, open ? "ok" : "err"))),
      h("div", { class: "spacer-line" }),
      table(
        [
          { title: "Port", width: "7ch", cell: (x: PortResult) => String(x.port), align: "right" },
          { title: "Dienst", width: "17ch", cell: (x) => h("span", { class: "dim" }, SERVICES[x.port] ?? "–") },
          { title: "Zeit", width: "8ch", cell: (x) => (x.ms === null ? "–" : `${x.ms} ms`), align: "right" },
          { title: "Status", width: "minmax(0, 1fr)", cell: statusTag },
        ],
        r.results,
      ),
    );
  };

  async function test(): Promise<void> {
    if (busy) return;
    const host = hostInput.value.trim();
    const invalid = validateTarget(host);
    const ports = parsePorts(portsInput.value);
    const problem = invalid ?? (typeof ports === "string" ? ports : null);
    if (problem || typeof ports === "string") {
      const msg = problem ?? String(ports);
      replaceChildren(resultBody, h("span", { class: "tag-err" }, msg));
      status(msg, "error");
      return;
    }
    busy = true;
    testBtn.textContent = "teste …";
    testBtn.disabled = true;
    replaceChildren(resultBody, h("span", { class: "dim" }, `teste ${ports.length} Port(s) auf ${host} …`));
    const cmd = `porttest ${host} ${ports.join(",")}`;
    try {
      const r = await backend.portTest({ host, ports, timeoutMs });
      renderResult(r);
      const open = r.results.filter((x) => x.status === "open").length;
      status(`Port-Test ${host}: ${open}/${r.results.length} offen`, open === r.results.length ? "ok" : "error");
      const words = { open: "offen", closed: "geschlossen", filtered: "gefiltert", error: "Fehler" };
      logToConsole(cmd, [
        `Adresse: ${r.address}`,
        ...r.results.map((x) => `${String(x.port).padStart(5)}  ${words[x.status].padEnd(11)}  ${x.ms === null ? "" : x.ms + " ms"}`),
      ]);
    } catch (err) {
      const msg = errorText(err);
      replaceChildren(resultBody, h("span", { class: "tag-err" }, msg));
      status(msg, "error");
      logToConsole(cmd, [msg], 1);
    } finally {
      busy = false;
      testBtn.textContent = "Testen";
      testBtn.disabled = false;
    }
  }

  testBtn.addEventListener("click", () => void test());
  for (const el of [hostInput, portsInput]) {
    el.addEventListener("input", updateHeading);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void test();
    });
  }
  updateHeading();
  return view;
}
