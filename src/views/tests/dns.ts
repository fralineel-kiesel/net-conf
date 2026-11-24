// Tests → DNS: Abfrage wie nslookup (eigener DNS-Client im Backend).
import { backend, errorText } from "../../api";
import { logToConsole } from "../../commands";
import { onStateChange, primaryAdapter } from "../../state";
import type { DnsRecord, DnsResponse } from "../../types";
import { h, replaceChildren } from "../../ui/dom";
import { status } from "../../ui/statusbar";
import { copyable, kvRow, panel, prompt, radio, table, tag, tbutton } from "../../ui/widgets";

const TYPES = ["A", "AAAA", "CNAME", "MX", "NS", "TXT", "PTR", "SOA"] as const;
type RecordType = (typeof TYPES)[number];

export function createDns(): HTMLElement {
  const heading = prompt("");
  const nameInput = h("input", {
    class: "tinput",
    type: "text",
    value: "google.com",
    spellcheck: "false",
    autocomplete: "off",
    placeholder: "Name oder (bei PTR) IP-Adresse",
    "aria-label": "Name",
  });
  const serverInput = h("input", {
    class: "tinput tinput-short",
    type: "text",
    value: "",
    spellcheck: "false",
    autocomplete: "off",
    placeholder: "System-DNS",
    "aria-label": "DNS-Server",
  });
  let recordType: RecordType = "A";
  const typeRadio = radio(
    TYPES.map((t) => ({ value: t, label: t })),
    recordType,
    (v) => {
      recordType = v;
      updateHeading();
    },
  );
  const queryBtn = tbutton("Abfragen");
  const serverQuick = h("span", { class: "quick" });
  const resultBody = h("div", {}, h("span", { class: "dim" }, "noch keine Abfrage"));

  const formPanel = panel(
    "DNS-ABFRAGE",
    {},
    kvRow("Name", h("span", { class: "input-wrap" }, h("span", { class: "dim" }, "> "), nameInput)),
    kvRow("Typ", typeRadio),
    kvRow("DNS-Server", h("span", { class: "input-wrap" }, h("span", { class: "dim" }, "> "), serverInput)),
    kvRow("Schnellwahl", serverQuick),
    h("div", { class: "panel-actions" }, queryBtn),
  );
  const resultPanel = panel("ANTWORT", {}, resultBody);
  const view = h("div", { class: "subview" }, heading.el, h("div", { class: "stack" }, formPanel.el, resultPanel.el));

  let busy = false;

  function updateHeading(): void {
    const server = serverInput.value.trim();
    heading.set(`nslookup -type=${recordType} ${nameInput.value.trim() || "<name>"}${server ? " " + server : ""}`);
  }

  const renderQuick = () => {
    const a = primaryAdapter();
    const gw = a?.gateways.find((g) => g.includes("."));
    const pick = (label: string, value: string | undefined, title: string) => {
      const b = tbutton(label, {
        title,
        onclick: () => {
          if (value === undefined) return;
          serverInput.value = value;
          updateHeading();
        },
      });
      b.disabled = value === undefined;
      return b;
    };
    replaceChildren(
      serverQuick,
      pick("System", "", "DNS-Server des Systems (wie im Adapter eingestellt)"),
      pick("Gateway", gw, gw ? `Router: ${gw}` : "kein Gateway gefunden"),
      pick("1.1.1.1", "1.1.1.1", "Cloudflare"),
      pick("8.8.8.8", "8.8.8.8", "Google"),
      pick("9.9.9.9", "9.9.9.9", "Quad9"),
    );
  };

  const records = (list: DnsRecord[]) =>
    table(
      [
        { title: "Name", width: "minmax(0, 2fr)", cell: (r: DnsRecord) => r.name },
        { title: "Typ", width: "6ch", cell: (r) => r.recordType },
        { title: "TTL", width: "8ch", cell: (r) => `${r.ttl}s`, align: "right" },
        { title: "Daten", width: "minmax(0, 3fr)", cell: (r) => copyable(r.data) },
      ],
      list,
    );

  const renderResult = (r: DnsResponse) => {
    const ok = r.rcode === 0;
    const parts: Node[] = [
      kvRow("Server", copyable(r.server)),
      kvRow("Name", r.queryName),
      kvRow(
        "Status",
        h(
          "span",
          {},
          tag(ok ? (r.answers.length ? "[OK]" : "[KEINE DATEN]") : "[FEHLER]", ok && r.answers.length ? "ok" : "err"),
          ` ${ok && !r.answers.length ? `Kein ${r.recordType}-Eintrag vorhanden` : r.rcodeText}`,
        ),
      ),
      kvRow("Antwortzeit", `${r.elapsedMs} ms`),
      kvRow("Autoritativ", r.authoritative ? "Ja" : "Nein (Antwort aus Cache/Weiterleitung)"),
    ];
    if (r.truncated) parts.push(kvRow("Hinweis", tag("Antwort wurde gekürzt (zu gross für UDP)", "err")));
    parts.push(h("div", { class: "spacer-line" }), records(r.answers));
    if (r.authority.length && !r.answers.length) {
      parts.push(h("div", { class: "spacer-line" }), h("div", { class: "dim" }, "AUTHORITY"), records(r.authority));
    }
    replaceChildren(resultBody, ...parts);
  };

  async function query(): Promise<void> {
    if (busy) return;
    const name = nameInput.value.trim();
    const server = serverInput.value.trim() || null;
    busy = true;
    queryBtn.textContent = "frage …";
    queryBtn.disabled = true;
    replaceChildren(resultBody, h("span", { class: "dim" }, "frage DNS-Server …"));
    const cmd = `nslookup -type=${recordType} ${name}${server ? " " + server : ""}`;
    try {
      const r = await backend.dnsQuery({ name, recordType, server });
      renderResult(r);
      status(
        r.rcode === 0 ? `DNS ${r.recordType} ${r.queryName}: ${r.answers.length} Einträge` : `DNS: ${r.rcodeText}`,
        r.rcode === 0 && r.answers.length ? "ok" : "error",
      );
      logToConsole(
        cmd,
        [
          `Server:  ${r.server}`,
          `Status:  ${r.rcodeText} (${r.elapsedMs} ms)`,
          ...r.answers.map((a) => `${a.name}  ${a.recordType}  ${a.ttl}s  ${a.data}`),
          ...(r.answers.length ? [] : r.authority.map((a) => `(Authority) ${a.name}  ${a.recordType}  ${a.data}`)),
        ],
        r.rcode,
      );
    } catch (err) {
      const msg = errorText(err);
      replaceChildren(resultBody, h("span", { class: "tag-err" }, msg));
      status(msg, "error");
      logToConsole(cmd, [msg], 1);
    } finally {
      busy = false;
      queryBtn.textContent = "Abfragen";
      queryBtn.disabled = false;
    }
  }

  queryBtn.addEventListener("click", () => void query());
  for (const el of [nameInput, serverInput]) {
    el.addEventListener("input", updateHeading);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void query();
    });
  }

  onStateChange(renderQuick);
  renderQuick();
  updateHeading();
  return view;
}
