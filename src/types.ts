// Datentypen – müssen zu den Rust-Strukturen (serde, camelCase) passen.

export interface Ipv4Entry {
  address: string;
  subnetMask: string;
}

export interface AdapterInfo {
  id: string;
  name: string;
  description: string;
  connected: boolean;
  mac: string;
  ipv4: Ipv4Entry[];
  ipv6: string[];
  gateways: string[];
  dnsServers: string[];
  dhcpEnabled: boolean;
  dhcpServer: string | null;
  /** Unix-Zeit in Sekunden */
  leaseObtained: number | null;
  leaseExpires: number | null;
  dnsSuffix: string;
}

/** Werkzeuge mit freier Eingabe – entspricht `NetCommand` in runner.rs.
 *  `count: null` = unbegrenzt (ping -t). Erlaubt sind nur PING_COUNTS. */
export type NetCommand =
  | { kind: "ping"; target: string; count: number | null }
  | { kind: "tracert"; target: string; resolve: boolean };

/** Erlaubte Ping-Anzahlen (gleiche Liste wie PING_COUNTS in runner.rs). */
export const PING_COUNTS = [2, 4, 8, 16, 32] as const;

/** Aktions-IDs – entspricht `ActionId` in actions.rs (Whitelist im Backend). */
export type ActionId =
  | "release"
  | "renew"
  | "releaseRenew"
  | "fullRefresh"
  | "flushDns"
  | "displayDns"
  | "registerDns"
  | "dnsRefresh"
  | "arpClear"
  | "nbtPurge"
  | "nbtReregister"
  | "adapterRestart"
  | "winsockReset"
  | "tcpipReset";

export interface StartedEvent {
  runId: number;
  commandLine: string;
}

/** Schrittmarker bei Abläufen mit mehreren Schritten, z. B. [1/3] ipconfig /release */
export interface StepEvent {
  runId: number;
  index: number;
  total: number;
  label: string;
  /** true = Schritt läuft nur noch zur Wiederherstellung (nach Fehler/Abbruch) */
  recovery: boolean;
}

export interface OutputEvent {
  runId: number;
  stream: "stdout" | "stderr";
  line: string;
}

export interface FinishedEvent {
  runId: number;
  exitCode: number | null;
  cancelled: boolean;
  /** 1-basiert: welcher Schritt zuerst gescheitert ist (null = keiner) */
  failedStep: number | null;
  /** Prozess liess sich nicht starten */
  error: string | null;
}

// ---- Phase 2 ---------------------------------------------------------------

export interface DnsRequest {
  name: string;
  recordType: string;
  /** IP des DNS-Servers, null = System-DNS */
  server: string | null;
}

export interface DnsRecord {
  name: string;
  recordType: string;
  ttl: number;
  data: string;
}

export interface DnsResponse {
  server: string;
  queryName: string;
  recordType: string;
  rcode: number;
  rcodeText: string;
  authoritative: boolean;
  truncated: boolean;
  elapsedMs: number;
  answers: DnsRecord[];
  authority: DnsRecord[];
}

export interface PortTestRequest {
  host: string;
  ports: number[];
  timeoutMs: number | null;
}

export interface PortResult {
  port: number;
  status: "open" | "closed" | "filtered" | "error";
  ms: number | null;
  message: string | null;
}

export interface PortTestResponse {
  host: string;
  address: string;
  results: PortResult[];
}

export interface NeighborEntry {
  address: string;
  family: 4 | 6;
  mac: string;
  interface: string;
  state: string;
  permanent: boolean;
}

export interface RouteEntry {
  destination: string;
  prefixLen: number;
  gateway: string;
  interface: string;
  metric: number;
  family: 4 | 6;
}

export interface WifiInfo {
  /** "{GUID}" – passt zu AdapterInfo.id */
  interfaceId: string;
  description: string;
  connected: boolean;
  state: string;
  ssid: string;
  bssid: string;
  profile: string;
  signalQuality: number | null;
  rssiDbm: number | null;
  channel: number | null;
  frequencyMhz: number | null;
  band: string | null;
  phy: string;
  rxMbps: number | null;
  txMbps: number | null;
  auth: string;
  cipher: string;
  error: string | null;
}

export interface PublicIp {
  ipv4: string | null;
  ipv6: string | null;
}
