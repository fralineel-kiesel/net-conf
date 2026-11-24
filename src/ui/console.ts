// Konsolen-Panel unten: zeigt die Live-Ausgabe aller Befehle.
// Ablauf pro Befehl:  "> ipconfig /renew"  →  Ausgabe  →  "[beendet - Code 0]"
// Bei Abläufen zusätzlich Schrittmarker: "[1/3] ipconfig /release"
import { events } from "../events";
import { registerCommands } from "../registry";
import { settings } from "../settings";
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
    // Optional mit Uhrzeit davor (Einstellungen → Konsole), praktisch für Tickets
    const stamp = settings.consoleTimestamps ? `[${new Date().toLocaleTimeString("de-CH")}] ` : "";
    body.append(h("div", { class: `line ${cls}` }, stamp + (text || (stamp ? "" : " "))));
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
  const multiStep = new Set<number>(); // runIds von Abläufen mit Schritten
  events.step.on((e) => {
    multiStep.add(e.runId);
    addLine(`[${e.index}/${e.total}] ${e.label}${e.recovery ? "   (Wiederherstellung)" : ""}`, "line-step");
  });
  events.output.on((e) => addLine(e.line, e.stream === "stderr" ? "tag-err" : ""));
  events.finished.on((e) => {
    setRunning(-1);
    const steps = multiStep.delete(e.runId);
    if (e.cancelled) addLine("[abgebrochen]", "dim");
    else if (steps && e.failedStep !== null) {
      addLine(`[fehlgeschlagen in Schritt ${e.failedStep} - Code ${e.exitCode ?? "?"}]`, "tag-err");
    } else addLine(`[beendet - Code ${e.exitCode ?? "?"}]`, e.exitCode === 0 ? "dim" : "tag-err");
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

  registerCommands([
    { id: "console.clear", title: "Konsole leeren", category: "AKTION", keywords: "ausgabe löschen", run: () => clear() },
    { id: "console.copy", title: "Konsole kopieren", category: "AKTION", keywords: "ausgabe zwischenablage", run: () => copyAll() },
    {
      id: "console.toggle",
      title: "Konsole ein-/ausklappen",
      category: "EINSTELLUNG",
      keywords: "ausgabe verstecken zeigen",
      run: () => setCollapsed(!p.el.classList.contains("collapsed")),
    },
  ]);

  return p.el;
}
