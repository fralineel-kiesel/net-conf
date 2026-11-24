// Navigation zwischen Ansichten, ohne dass sich die Module gegenseitig importieren
// (sonst entstehen Import-Schleifen). main.ts, tests.ts und ping.ts tragen hier
// beim Start ihre Funktionen ein.
import type { ViewId } from "./settings";

export const nav = {
  show: (_view: ViewId): void => {},
  showTestsTab: (_tab: "ping" | "tracert" | "dns" | "port" | "health" | "monitor"): void => {},
  startPing: (_target: string): void => {},
  // Phase 4c (Befehlspalette, Werkzeuge)
  startTracert: (_target: string): void => {},
  startDns: (_name: string): void => {},
  wake: (_device: string): void => {},
  openSubnet: (_text: string): void => {},
  applyProfile: (_name: string): void => {},
  showToolsTab: (_tab: "subnet" | "profiles"): void => {},
  startHealth: (): void => {},
};

/** Zum Ping-Test springen und dort `target` anpingen (z. B. aus dem LAN-Scanner). */
export function pingHost(target: string): void {
  nav.show("tests");
  nav.showTestsTab("ping");
  nav.startPing(target);
}
