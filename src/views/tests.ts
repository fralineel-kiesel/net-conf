// Ansicht "Tests": Reiter für Ping, Traceroute, DNS, Port-Test, Health-Check und Monitor.
import { nav } from "../nav";
import { h, prefs } from "../ui/dom";
import { tabs } from "../ui/widgets";
import { createDns } from "./tests/dns";
import { createHealth } from "./tests/health";
import { createMonitor } from "./tests/monitor";
import { createPing } from "./tests/ping";
import { createPort } from "./tests/port";
import { createTracert } from "./tests/tracert";

export type TabId = "ping" | "tracert" | "dns" | "port" | "health" | "monitor";

const TABS: { value: TabId; label: string }[] = [
  { value: "ping", label: "Ping" },
  { value: "tracert", label: "Traceroute" },
  { value: "dns", label: "DNS" },
  { value: "port", label: "Port" },
  { value: "health", label: "Health" },
  { value: "monitor", label: "Monitor" },
];

export interface TestsView {
  el: HTMLElement;
  /** Zum nächsten Reiter wechseln (F3, wenn "Tests" schon offen ist) */
  next(): void;
  /** Bestimmten Reiter zeigen (z. B. vom LAN-Scanner aus) */
  showTab(id: TabId): void;
}

export function createTests(): TestsView {
  const views: Record<TabId, HTMLElement> = {
    ping: createPing(),
    tracert: createTracert(),
    dns: createDns(),
    port: createPort(),
    health: createHealth(),
    monitor: createMonitor(),
  };
  const saved = prefs.get("testsTab", "ping") as TabId;
  let current: TabId = saved in views ? saved : "ping";

  const show = (id: TabId) => {
    current = id;
    for (const [key, el] of Object.entries(views)) el.hidden = key !== id;
    bar.set(id);
    prefs.set("testsTab", id);
  };
  const bar = tabs(TABS, current, show);

  const el = h("section", { class: "view", "data-view": "tests" }, bar.el, ...Object.values(views));
  show(current);
  nav.showTestsTab = show;

  return {
    el,
    showTab: show,
    next: () => {
      const i = TABS.findIndex((t) => t.value === current);
      show(TABS[(i + 1) % TABS.length].value);
    },
  };
}
