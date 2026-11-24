// Konsolen-Panel unten: zeigt die Live-Ausgabe aller Befehle.
// Ablauf pro Befehl:  "> ipconfig /renew"  →  Ausgabe  →  "[beendet - Code 0]"
import { events } from "../events";
import { copyText, h, prefs } from "./dom";
import { status } from "./statusbar";
import { panel, tag, tbutton } from "./widgets";

const MAX_LINES = 5000;

export function createConsole(): HTMLElement {
  const body = h("div", { class: "console-body", tabindex: "0", "aria-label": "Konsolenausgabe" });
  const running = tag("[LÄUFT]", "ok");
  running.hidden = true;
  const count = h("span", { class: "dim" });
  const toggleBtn = tbutton("-", { title: "Konsole ein-/ausklappen" });

  const p = panel(
    "KONSOLE",
    {
      cls: "console",
      right: [
        running,
        count,
        tbutton("Kopieren", { onclick: () => void copyAll(), title: "Gesamte Ausgabe kopieren" }),
        tbutton("Leeren", { onclick: () => clear(), title: "Ausgabe leeren" }),
        toggleBtn,
      ],
    },
    body,
  );

  const setCollapsed = (collapsed: boolean) => {
    p.el.classList.toggle("collapsed", collapsed);
    toggleBtn.textContent = collapsed ? "+" : "-";
    toggleBtn.setAttribute("aria-expanded", String(!collapsed));
    prefs.set("consoleCollapsed", collapsed ? "1" : "0");
  };
  setCollapsed(prefs.get("consoleCollapsed", "0") === "1");
  toggleBtn.addEventListener("click", () => setCollapsed(!p.el.classList.contains("collapsed")));

  const updateCount = () => {
    const n = body.childElementCount;
    count.textContent = n ? `${n} Zeilen` : "";
  };

  // Nur automatisch nach unten scrollen, wenn man schon unten war –
  // sonst springt die Ansicht weg, während man oben etwas liest.
  const addLine = (text: string, cls = "") => {
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
    body.append(h("div", { class: `line ${cls}` }, text || " "));
    while (body.childElementCount > MAX_LINES) body.firstElementChild?.remove();
    if (atBottom) body.scrollTop = body.scrollHeight;
    updateCount();
  };

  let active = 0;
  const setRunning = (delta: number) => {
    active = Math.max(0, active + delta);
    running.hidden = active === 0;
  };

  events.started.on((e) => {
    setCollapsed(false); // bei neuem Befehl Konsole aufklappen
    setRunning(+1);
    addLine(`> ${e.commandLine}`, "line-cmd");
    body.scrollTop = body.scrollHeight;
  });
  events.output.on((e) => addLine(e.line, e.stream === "stderr" ? "tag-err" : ""));
  events.finished.on((e) => {
    setRunning(-1);
    if (e.cancelled) addLine("[abgebrochen]", "dim");
    else addLine(`[beendet - Code ${e.exitCode ?? "?"}]`, e.exitCode === 0 ? "dim" : "tag-err");
  });

  async function copyAll(): Promise<void> {
    const text = Array.from(body.children, (l) => (l.textContent === " " ? "" : l.textContent)).join("\r\n");
    if (!text) return status("Konsole ist leer");
    if (await copyText(text)) status("kopiert: Konsolenausgabe", "ok");
    else status("Kopieren fehlgeschlagen", "error");
  }

  function clear(): void {
    body.replaceChildren();
    updateCount();
    status("Konsole geleert");
  }

  return p.el;
}
