// Navigation zwischen Ansichten, ohne dass sich die Module gegenseitig importieren
// (sonst entstehen Import-Schleifen). main.ts, tests.ts und ping.ts tragen hier
// beim Start ihre Funktionen ein.
import type { ViewId } from "./settings";

export const nav = {
  show: (_view: ViewId): void => {},
  showTestsTab: (_tab: "ping"): void => {},
  startPing: (_target: string): void => {},
};

/** Zum Ping-Test springen und dort `target` anpingen (z. B. aus dem LAN-Scanner). */
export function pingHost(target: string): void {
  nav.show("tests");
  nav.showTestsTab("ping");
  nav.startPing(target);
}
