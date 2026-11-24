// Ansicht "Werkzeuge" (F9): Reiter Subnetz-Rechner und IP-Profile.
import { nav } from "../nav";
import { h, prefs } from "../ui/dom";
import { tabs } from "../ui/widgets";
import { createProfiles } from "./tools/profiles";
import { createSubnet } from "./tools/subnet";

export type ToolsTab = "subnet" | "profiles";

const TABS: { value: ToolsTab; label: string }[] = [
  { value: "subnet", label: "Subnetz" },
  { value: "profiles", label: "IP-Profile" },
];

export interface ToolsView {
  el: HTMLElement;
  /** Nächster Reiter (F9, wenn Werkzeuge schon offen ist) */
  next(): void;
}

export function createTools(): ToolsView {
  const subnet = createSubnet();
  const profiles = createProfiles();
  const views: Record<ToolsTab, HTMLElement> = { subnet: subnet.el, profiles: profiles.el };
  let current: ToolsTab = prefs.get("toolsTab", "subnet") === "profiles" ? "profiles" : "subnet";

  const show = (id: ToolsTab) => {
    current = id;
    for (const [key, el] of Object.entries(views)) el.hidden = key !== id;
    bar.set(id);
    prefs.set("toolsTab", id);
  };
  const bar = tabs(TABS, current, show);
  const el = h("section", { class: "view", "data-view": "tools" }, bar.el, ...Object.values(views));
  show(current);

  // Sprünge aus anderen Ansichten bzw. der Befehlspalette
  nav.openSubnet = (text: string) => {
    nav.show("tools");
    show("subnet");
    subnet.prefill(text);
  };
  nav.applyProfile = (name: string) => {
    nav.show("tools");
    show("profiles");
    void profiles.applyByName(name);
  };
  nav.showToolsTab = show;

  return {
    el,
    next: () => show(current === "subnet" ? "profiles" : "subnet"),
  };
}
