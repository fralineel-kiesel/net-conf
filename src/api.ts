// Brücke zum Rust-Backend. Läuft die Seite im normalen Browser (ohne
// Tauri), werden automatisch Mock-Daten verwendet (siehe mock.ts).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { events } from "./events";
import * as mock from "./mock";
import type {
  AdapterInfo,
  DnsRequest,
  DnsResponse,
  FinishedEvent,
  NeighborEntry,
  NetCommand,
  OutputEvent,
  PortTestRequest,
  PortTestResponse,
  PublicIp,
  RouteEntry,
  StartedEvent,
  WifiInfo,
} from "./types";

/** true, wenn wir in der echten Tauri-App laufen. */
export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Einmal beim Start aufrufen: Tauri-Events an unseren Verteiler anschliessen. */
export async function initBackend(): Promise<void> {
  if (!isTauri) {
    console.info("[Net-Conf] Keine Tauri-API gefunden – Mock-Modus aktiv.");
    return;
  }
  await Promise.all([
    listen<StartedEvent>("cmd-started", (e) => events.started.emit(e.payload)),
    listen<OutputEvent>("cmd-output", (e) => events.output.emit(e.payload)),
    listen<FinishedEvent>("cmd-finished", (e) => events.finished.emit(e.payload)),
  ]);
}

export const backend = {
  getAdapters: (): Promise<AdapterInfo[]> =>
    isTauri ? invoke<AdapterInfo[]>("get_adapters") : mock.getAdapters(),

  getHostname: (): Promise<string> =>
    isTauri ? invoke<string>("get_hostname") : mock.getHostname(),

  isAdmin: (): Promise<boolean> => (isTauri ? invoke<boolean>("is_admin") : mock.isAdmin()),

  restartAsAdmin: (): Promise<void> =>
    isTauri ? invoke<void>("restart_as_admin") : mock.restartAsAdmin(),

  runCommand: (runId: number, command: NetCommand): Promise<void> =>
    isTauri ? invoke<void>("run_command", { runId, command }) : mock.runCommand(runId, command),

  cancelCommand: (runId: number): Promise<void> =>
    isTauri ? invoke<void>("cancel_command", { runId }) : mock.cancelCommand(runId),

  // ---- Phase 2 ----
  dnsQuery: (request: DnsRequest): Promise<DnsResponse> =>
    isTauri ? invoke<DnsResponse>("dns_query", { request }) : mock.dnsQuery(request),

  portTest: (request: PortTestRequest): Promise<PortTestResponse> =>
    isTauri ? invoke<PortTestResponse>("port_test", { request }) : mock.portTest(request),

  getArpTable: (): Promise<NeighborEntry[]> =>
    isTauri ? invoke<NeighborEntry[]>("get_arp_table") : mock.getArpTable(),

  getRouteTable: (): Promise<RouteEntry[]> =>
    isTauri ? invoke<RouteEntry[]>("get_route_table") : mock.getRouteTable(),

  getWifi: (): Promise<WifiInfo[]> => (isTauri ? invoke<WifiInfo[]>("get_wifi") : mock.getWifi()),

  /** Öffentliche IP über ipify.org – nur auf ausdrücklichen Klick aufrufen! */
  getPublicIp: (): Promise<PublicIp> => (isTauri ? fetchPublicIp() : mock.getPublicIp()),
};

/**
 * Öffentliche IP direkt aus dem WebView abfragen (HTTPS). Vorteil: kein
 * HTTP-/TLS-Crate im Backend nötig, und WebView2 nutzt automatisch den
 * Windows-Proxy (wichtig in Firmennetzen). Erlaubt in der CSP (tauri.conf.json).
 */
async function fetchPublicIp(): Promise<PublicIp> {
  const get = async (url: string, re: RegExp): Promise<string | null> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    try {
      const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
      if (!res.ok) return null;
      const text = (await res.text()).trim();
      return re.test(text) ? text : null; // nur echte IPs anzeigen
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
  const [ipv4, ipv6] = await Promise.all([
    get("https://api.ipify.org", /^\d{1,3}(\.\d{1,3}){3}$/),
    get("https://api6.ipify.org", /^[0-9a-fA-F:]+$/),
  ]);
  if (!ipv4 && !ipv6) {
    throw "Die öffentliche IP konnte nicht ermittelt werden (keine Internetverbindung oder ipify.org blockiert).";
  }
  return { ipv4, ipv6 };
}

/** Fehler aus invoke() (meist ein String vom Backend) lesbar machen. */
export function errorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return String(err);
}
