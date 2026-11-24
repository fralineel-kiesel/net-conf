// Tests → Health: prüft die Netzwerk-Kette Stufe für Stufe (Logik in src/health.ts).
import { backend } from "../../api";
import { logToConsole } from "../../commands";
import { reportLines, runHealthCheck, statusLabel, summary, type Evaluation, type StageStatus } from "../../health";
import { refreshAll } from "../../state";
import { copyText, h, replaceChildren } from "../../ui/dom";
import { status } from "../../ui/statusbar";
import { kvRow, panel, prompt, tag, tbutton } from "../../ui/widgets";

const TAG_KIND: Record<StageStatus, "ok" | "err" | "dim" | "plain"> = {
  ok: "ok",
  warn: "plain",
  fail: "err",
  skip: "dim",
  pending: "dim",
  running: "plain",
};

const timeFmt = new Intl.DateTimeFormat("de-CH", { dateStyle: "medium", timeStyle: "medium" });

export function createHealth(): HTMLElement {
  const checkBtn = tbutton("Prüfen", { cls: "tbtn-wide" });
  const copyBtn = tbutton("Kopieren", { title: "Ergebnis als Text kopieren (z. B. für ein Ticket)" });
  copyBtn.disabled = true;
  const body = h("div", { class: "health" });
  const p = panel(
    "HEALTH-CHECK",
    { right: [copyBtn] },
    h(
      "p",
      { class: "dim wrap" },
      "Prüft die Kette Adapter → IP → Gateway → DNS → Internet. Pings laufen nativ über ICMP (ohne ping.exe, ohne Adminrechte).",
    ),
    h("div", { class: "spacer-line" }),
    body,
    h("div", { class: "panel-actions" }, checkBtn),
  );
  const view = h("div", { class: "subview" }, prompt("netconf health").el, h("div", { class: "stack" }, p.el));

  let last: Evaluation | null = null;
  let lastWhen = "";
  let busy = false;

  const render = (e: Evaluation | null) => {
    if (!e) {
      replaceChildren(body, h("span", { class: "dim" }, "noch nicht geprüft – [ Prüfen ] startet den Check."));
      return;
    }
    const rows = e.stages.map((s, i) =>
      kvRow(
        `${i + 1} ${s.title}`,
        h(
          "span",
          { class: "health-line" },
          h("span", { class: `health-tag ${s.status === "warn" ? "bright" : ""}` }, tag(statusLabel(s.status), TAG_KIND[s.status])),
          s.value ? h("span", { class: s.status === "pending" ? "dim" : "" }, s.value) : null,
          // Übersprungen: Grund direkt in der Zeile statt darunter
          !s.value && s.hint ? h("span", { class: "dim" }, s.hint) : null,
        ),
        s.value && s.hint ? h("span", { class: "dim wrap health-hint" }, s.hint) : null,
      ),
    );
    const done = !e.stages.some((s) => s.status === "running" || s.status === "pending");
    const diag = done
      ? kvRow("Diagnose", h("span", { class: `wrap ${e.failed ? "tag-err" : "tag-ok"}` }, summary(e)))
      : kvRow("Diagnose", h("span", { class: "dim" }, "…"));
    replaceChildren(body, ...rows, h("div", { class: "spacer-line" }), diag);
  };

  async function run(): Promise<void> {
    if (busy) return;
    busy = true;
    checkBtn.textContent = "prüfe …";
    checkBtn.disabled = true;
    copyBtn.disabled = true;
    status("Health-Check läuft …");
    try {
      last = await runHealthCheck(
        {
          getAdapters: () => backend.getAdapters(),
          ping: (t, ms) => backend.icmpPing(t, ms),
          resolve: (n, ms) => backend.resolveName(n, ms),
        },
        render,
      );
      lastWhen = timeFmt.format(new Date());
      render(last);
      const text = summary(last);
      status(`Health-Check: ${text}`, last.failed ? "error" : "ok");
      logToConsole("netconf health", reportLines(last, lastWhen), last.failed ? 1 : 0);
      void refreshAll(); // Übersicht gleich mit aktualisieren
    } catch (err) {
      const msg = `Health-Check abgebrochen: ${typeof err === "string" ? err : String(err)}`;
      replaceChildren(body, h("span", { class: "tag-err" }, msg));
      status(msg, "error");
    } finally {
      busy = false;
      checkBtn.textContent = "Prüfen";
      checkBtn.disabled = false;
      copyBtn.disabled = last === null;
    }
  }

  checkBtn.addEventListener("click", () => void run());
  copyBtn.addEventListener("click", async () => {
    if (!last) return;
    if (await copyText(reportLines(last, lastWhen).join("\r\n"))) status("kopiert: Health-Check-Ergebnis", "ok");
    else status("Kopieren fehlgeschlagen", "error");
  });

  render(null);
  return view;
}
