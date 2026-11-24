// Brücke zum Rust-Backend. Läuft die Seite im normalen Browser (ohne
// Tauri), werden automatisch Mock-Daten verwendet (siehe mock.ts).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { events } from "./events";
import * as mock from "./mock";
import type {
  ActionId,
  AdapterInfo,
  AppConfig,
  ConfigLoadResult,
  LanFinishedEvent,
  LanHostEvent,
  LanProgressEvent,
  MonitorStatus,
  MonitorTarget,
  MonitorUpdate,
  PingResult,
  ResolveResult,
  ScanStarted,
  WolResult,
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
  StepEvent,
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
    listen<StepEvent>("cmd-step", (e) => events.step.emit(e.payload)),
    listen<OutputEvent>("cmd-output", (e) => events.output.emit(e.payload)),
    listen<FinishedEvent>("cmd-finished", (e) => events.finished.emit(e.payload)),
    listen<MonitorUpdate>("monitor-update", (e) => events.monitor.emit(e.payload)),
    listen<LanHostEvent>("lan-host", (e) => events.lanHost.emit(e.payload)),
    listen<LanProgressEvent>("lan-progress", (e) => events.lanProgress.emit(e.payload)),
    listen<LanFinishedEvent>("lan-finished", (e) => events.lanFinished.emit(e.payload)),
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

  /** Aktion aus der Whitelist starten – es geht nur die ID über die Brücke. */
  runAction: (runId: number, action: ActionId, adapter: string | null): Promise<void> =>
    isTauri ? invoke<void>("run_action", { runId, action, adapter }) : mock.runAction(runId, action, adapter),

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

  // ---- Phase 4a: Diagnose ----
  /** Nativer Ping über IcmpSendEcho (ohne ping.exe). Nur IPv4. */
  icmpPing: (target: string, timeoutMs: number): Promise<PingResult> =>
    isTauri ? invoke<PingResult>("icmp_ping", { target, timeoutMs }) : mock.icmpPing(target, timeoutMs),

  /** Namensauflösung über den System-Resolver, mit Zeitlimit. */
  resolveName: (name: string, timeoutMs: number): Promise<ResolveResult> =>
    isTauri ? invoke<ResolveResult>("resolve_name", { name, timeoutMs }) : mock.resolveName(name, timeoutMs),

  loadConfig: (): Promise<ConfigLoadResult> =>
    isTauri ? invoke<ConfigLoadResult>("load_config") : mock.loadConfig(),

  /** Speichert config.json (Backend prüft alles und gibt die normalisierte Fassung zurück). */
  saveConfig: (config: AppConfig): Promise<AppConfig> =>
    isTauri ? invoke<AppConfig>("save_config", { config }) : mock.saveConfig(config),

  monitorSet: (targets: MonitorTarget[], intervalSec: number): Promise<MonitorStatus> =>
    isTauri ? invoke<MonitorStatus>("monitor_set", { targets, intervalSec }) : mock.monitorSet(targets, intervalSec),

  monitorStart: (): Promise<MonitorStatus> =>
    isTauri ? invoke<MonitorStatus>("monitor_start") : mock.monitorStart(),

  monitorStop: (): Promise<MonitorStatus> =>
    isTauri ? invoke<MonitorStatus>("monitor_stop") : mock.monitorStop(),

  monitorStatus: (): Promise<MonitorStatus> =>
    isTauri ? invoke<MonitorStatus>("monitor_status") : mock.monitorStatus(),

  monitorClearLog: (): Promise<void> =>
    isTauri ? invoke<void>("monitor_clear_log") : mock.monitorClearLog(),

  /** LAN-Scan: nur Adaptername + eigene Adresse – das Subnetz bestimmt das Backend. */
  lanScanStart: (scanId: number, adapter: string, address: string): Promise<ScanStarted> =>
    isTauri
      ? invoke<ScanStarted>("lan_scan_start", { scanId, adapter, address })
      : mock.lanScanStart(scanId, adapter, address),

  lanScanCancel: (): Promise<void> => (isTauri ? invoke<void>("lan_scan_cancel") : mock.lanScanCancel()),

  wolSend: (mac: string, adapter: string, address: string): Promise<WolResult> =>
    isTauri ? invoke<WolResult>("wol_send", { mac, adapter, address }) : mock.wolSend(mac, adapter, address),

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
