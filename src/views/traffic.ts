// Ansicht "Traffic" (F8): Reiter "Live" (Datenrate eines Adapters) und
// "Verbindungen" (TCP/UDP mit Prozess). Nochmal F8 = nächster Reiter.
//
// Die Live-Messung läuft, solange die Seite offen ist (egal welcher Reiter),
// und stoppt beim Verlassen. Die Auto-Aktualisierung der Verbindungen läuft
// nur, solange deren Reiter sichtbar ist.
import { h, prefs } from "../ui/dom";
import { tabs } from "../ui/widgets";
import { createConnections } from "./traffic/connections";
import { createLive } from "./traffic/live";

type TabId = "live" | "conns";

const TABS: { value: TabId; label: string }[] = [
  { value: "live", label: "Live" },
  { value: "conns", label: "Verbindungen" },
];

export interface TrafficView {
  el: HTMLElement;
  activate(): void;
  deactivate(): void;
  /** Nächster Reiter (F8, wenn "Traffic" schon offen ist) */
  next(): void;
}

export function createTraffic(): TrafficView {
  const live = createLive();
  const conns = createConnections();
  let tab: TabId = prefs.get("trafficTab", "live") === "conns" ? "conns" : "live";
  let pageActive = false;

  const show = (id: TabId) => {
    tab = id;
    live.el.hidden = id !== "live";
    conns.el.hidden = id !== "conns";
    bar.set(id);
    prefs.set("trafficTab", id);
    if (pageActive && id === "conns") conns.activate();
    else conns.deactivate();
  };
  const bar = tabs(TABS, tab, show);
  const el = h("section", { class: "view", "data-view": "traffic" }, bar.el, live.el, conns.el);
  show(tab);

  return {
    el,
    activate: () => {
      pageActive = true;
      live.start();
      if (tab === "conns") conns.activate();
    },
    deactivate: () => {
      pageActive = false;
      live.stop();
      conns.deactivate();
    },
    next: () => show(tab === "live" ? "conns" : "live"),
  };
}
