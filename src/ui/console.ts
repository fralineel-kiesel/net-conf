// Einklappbares Konsolen-Panel unten: zeigt die Live-Ausgabe aller Befehle.
import { events } from "../events";
import { toast } from "./toast";
import { copyText, h, icon, prefs } from "./dom";

const MAX_LINES = 5000;

export function createConsole(): HTMLElement {
  const body = h("div", { class: "console-body", tabindex: "0", "aria-label": "Konsolenausgabe" });
  const runningDot = h("span", { class: "run-dot", title: "Befehl läuft" });
  const lineCount = h("span", { class: "console-count" });
  const toggleBtn = h(
    "button",
    { class: "console-toggle", "aria-expanded": "true", title: "Konsole ein-/ausklappen" },
    icon("chevron", "icon chevron"),
    icon("terminal"),
    h("span", {}, "Konsole"),
    runningDot,
    lineCount,
  );
  const copyBtn = h("button", { class: "btn btn-small btn-ghost", title: "Gesamte Ausgabe kopieren" }, icon("copy"), "Kopieren");
  const clearBtn = h("button", { class: "btn btn-small btn-ghost", title: "Ausgabe leeren" }, icon("trash"), "Leeren");

  const panel = h(
    "section",
    { class: "console", "aria-label": "Konsole" },
    h("div", { class: "console-header" }, toggleBtn, h("div", { class: "console-tools" }, copyBtn, clearBtn)),
    body,
  );

  const setCollapsed = (collapsed: boolean) => {
    panel.classList.toggle("collapsed", collapsed);
    toggleBtn.setAttribute("aria-expanded", String(!collapsed));
    prefs.set("consoleCollapsed", collapsed ? "1" : "0");
  };
  setCollapsed(prefs.get("consoleCollapsed", "0") === "1");
  toggleBtn.addEventListener("click", () => setCollapsed(!panel.classList.contains("collapsed")));

  const updateCount = () => {
    const n = body.childElementCount;
    lineCount.textContent = n ? `${n} Zeilen` : "";
  };

  // Nur automatisch nach unten scrollen, wenn man schon unten war –
  // sonst springt die Ansicht weg, während man oben etwas liest.
  const addLine = (text: string, cls: string) => {
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
    body.append(h("div", { class: `line ${cls}` }, text || " "));
    while (body.childElementCount > MAX_LINES) body.firstElementChild?.remove();
    if (atBottom) body.scrollTop = body.scrollHeight;
    updateCount();
  };

  let runningCount = 0;
  const setRunning = (delta: number) => {
    runningCount = Math.max(0, runningCount + delta);
    runningDot.classList.toggle("active", runningCount > 0);
  };

  events.started.on((e) => {
    setCollapsed(false); // bei neuem Befehl Konsole aufklappen
    setRunning(+1);
    const time = new Date().toLocaleTimeString("de-CH");
    addLine(`[${time}] > ${e.commandLine}`, "line-cmd");
    body.scrollTop = body.scrollHeight;
  });
  events.output.on((e) => addLine(e.line, e.stream === "stderr" ? "line-err" : ""));
  events.finished.on((e) => {
    setRunning(-1);
    if (e.cancelled) addLine("[abgebrochen]", "line-meta");
    else addLine(`[beendet – Code ${e.exitCode ?? "?"}]`, e.exitCode === 0 ? "line-meta" : "line-meta line-err");
  });

  copyBtn.addEventListener("click", async () => {
    const text = Array.from(body.children, (l) => (l.textContent === " " ? "" : l.textContent)).join("\r\n");
    if (!text) return toast("Konsole ist leer");
    toast((await copyText(text)) ? "Konsolenausgabe kopiert" : "Kopieren fehlgeschlagen", "info");
  });
  clearBtn.addEventListener("click", () => {
    body.replaceChildren();
    updateCount();
  });

  return panel;
}
