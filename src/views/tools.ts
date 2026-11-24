// Ansicht "Werkzeuge" (F9): Reiter Subnetz-Rechner und IP-Profile.
import { nav } from "../nav";
import { config } from "../config";
import { registerCommand, registerCommands } from "../registry";
import { parseInput } from "../subnet";
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

  // Befehlspalette
  registerCommands(
    TABS.map((t) => ({
      id: `tab.tools.${t.value}`,
      title: `Werkzeuge: ${t.label}`,
      category: "SEITE" as const,
      hint: "F9",
      run: () => {
        nav.show("tools");
        show(t.value);
      },
    })),
  );
  registerCommand({
    id: "tool.subnet",
    title: "subnet <ip/cidr>",
    category: "TOOL",
    keywords: "subnetz rechner ipcalc maske netz",
    param: {
      keyword: "subnet",
      placeholder: "<ip/cidr>",
      validate: (arg) => {
        const r = parseInput(arg);
        return "error" in r ? r.error : null;
      },
    },
    run: (arg) => nav.openSubnet(arg!),
  });
  const profileByName = (name: string) => config().ipProfiles.find((p) => p.name.toLowerCase() === name.trim().toLowerCase());
  registerCommand({
    id: "tool.profile",
    title: "profil <Name>",
    category: "TOOL",
    keywords: "ip-profil anwenden statisch dhcp netsh",
    hint: "[ADMIN] [!]",
    param: {
      keyword: "profil",
      placeholder: "<Name>",
      validate: (name) => (profileByName(name) ? null : `Kein IP-Profil „${name.trim()}“ (Werkzeuge → IP-Profile).`),
      suggest: () => config().ipProfiles.map((p) => p.name),
    },
    // Läuft durch dieselbe Funktion wie [ Anwenden ]: Admin-Prüfung, Vorschau, Bestätigung, Countdown
    run: (name) => nav.applyProfile(profileByName(name!)!.name),
  });

  return {
    el,
    next: () => show(current === "subnet" ? "profiles" : "subnet"),
  };
}
