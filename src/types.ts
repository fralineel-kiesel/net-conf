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

// ---- Phase 4a: Diagnose ----------------------------------------------------

/** Nativer Ping (icmp.rs) */
export interface PingResult {
  address: string;
  status: "ok" | "timeout" | "unreachable" | "error";
  rttMs: number | null;
  ttl: number | null;
  message: string | null;
}

/** System-Namensauflösung (Health-Check) */
export interface ResolveResult {
  addresses: string[];
  elapsedMs: number;
}

export interface MonitorTarget {
  name: string;
  host: string;
}

export interface WolDevice {
  name: string;
  /** "AA-BB-CC-DD-EE-FF" (normalisiert vom Backend) */
  mac: string;
  ip: string | null;
  note: string;
}

/** Inhalt von config.json (config.rs) */
export interface AppConfig {
  version: number;
  monitorTargets: MonitorTarget[];
  monitorIntervalSec: number;
  wolDevices: WolDevice[];
  /** Werkzeuge → IP-Profile (ipprofile.rs) */
  ipProfiles: IpProfile[];
  /** Fenster schliessen = in den Tray */
  closeToTray: boolean;
}

export interface ConfigLoadResult {
  config: AppConfig;
  /** z. B. "config.json war beschädigt …" */
  notice: string | null;
  path: string;
}

/** Erlaubte Monitor-Intervalle (gleich wie MONITOR_INTERVALS in config.rs) */
export const MONITOR_INTERVALS = [1, 2, 5, 10] as const;
export const MAX_MONITOR_TARGETS = 20;

export interface MonitorTargetView {
  name: string;
  host: string;
  address: string | null;
  status: "unknown" | "up" | "down";
  lastMs: number | null;
  avgMs: number | null;
  sent: number;
  received: number;
  lossPercent: number;
  history: (number | null)[];
  /** Unix-ms des letzten Statuswechsels */
  sinceMs: number | null;
  error: string | null;
}

export interface MonitorLogEntry {
  timeMs: number;
  name: string;
  host: string;
  kind: "down" | "up";
  afterSec: number | null;
}

export interface MonitorStatus {
  running: boolean;
  intervalSec: number;
  targets: MonitorTargetView[];
  log: MonitorLogEntry[];
}

/** Event "monitor-update": wie MonitorStatus, aber nur die NEUEN Log-Einträge */
export interface MonitorUpdate {
  running: boolean;
  intervalSec: number;
  targets: MonitorTargetView[];
  newLog: MonitorLogEntry[];
}

export interface LanHost {
  ip: string;
  mac: string;
  latencyMs: number | null;
  hostname: string | null;
  /** true, solange Latenz/Name noch ermittelt werden */
  pending: boolean;
}

export interface LanHostEvent {
  scanId: number;
  host: LanHost;
}

export interface LanProgressEvent {
  scanId: number;
  done: number;
  total: number;
}

export interface LanFinishedEvent {
  scanId: number;
  cancelled: boolean;
  found: number;
  elapsedMs: number;
}

export interface ScanStarted {
  /** z. B. "192.168.1.0/24" */
  network: string;
  total: number;
}

export interface WolResult {
  mac: string;
  sentTo: string[];
}

// ---- Phase 4b: WLAN, Traffic, Verbindungen ---------------------------------

/** So kann Net-Conf verbinden (wifiprofile.rs). null = nicht unterstützt (802.1X, WEP …) */
export type WifiSecurity = "open" | "wpa2" | "wpa3";

/** Ein Netz in der Umgebung (mehrere APs mit gleicher SSID zusammengefasst) */
export interface WifiNetwork {
  /** leer = verstecktes Netz */
  ssid: string;
  hidden: boolean;
  signal: number;
  rssiDbm: number | null;
  channel: number | null;
  band: string | null;
  apCount: number;
  /** "OFFEN" | "WPA2" | "WPA3" | "WEP" | "WPA" | "OWE" | "802.1X" | "?" */
  security: string;
  connectAs: WifiSecurity | null;
  connected: boolean;
  saved: boolean;
  profile: string;
}

/** Ein einzelner Access Point (für die Kanal-Belegung) */
export interface WifiBss {
  ssid: string;
  bssid: string;
  signal: number;
  rssiDbm: number;
  frequencyMhz: number;
  channel: number | null;
  band: string | null;
}

export interface WifiScanResult {
  networks: WifiNetwork[];
  bss: WifiBss[];
  hint: string | null;
}

export interface WifiProfile {
  name: string;
  groupPolicy: boolean;
  perUser: boolean;
}

/** Neues Netz verbinden. Das Passwort nur hier – nie speichern oder loggen! */
export interface WifiConnectRequest {
  interfaceId: string;
  ssid: string;
  password: string;
  security: WifiSecurity;
  hidden: boolean;
}

/** Live-Traffic eines Adapters (traffic.rs) */
export interface IfTraffic {
  id: string;
  name: string;
  description: string;
  connected: boolean;
  isVirtual: boolean;
  rxDelta: number | null;
  txDelta: number | null;
  /** bit/s */
  rxBps: number | null;
  txBps: number | null;
  rxLinkBps: number | null;
  txLinkBps: number | null;
}

export interface TrafficSample {
  elapsedMs: number | null;
  interfaces: IfTraffic[];
}

/** Eine Verbindung (connections.rs, wie netstat -ano) */
export interface Connection {
  proto: "TCP" | "UDP";
  family: 4 | 6;
  localAddr: string;
  localPort: number;
  /** leer bei UDP */
  remoteAddr: string;
  remotePort: number;
  /** leer bei UDP */
  state: string;
  pid: number;
  process: string;
}

// ---- Phase 4c: Werkzeuge und Komfort ---------------------------------------

/** IP-Profil (ipprofile.rs). Leere Strings = nicht gesetzt. */
export interface IpProfile {
  name: string;
  /** Adaptername beim Speichern – gesucht wird beim Anwenden über die MAC */
  adapter: string;
  mac: string;
  mode: "dhcp" | "static";
  ipv4: string;
  /** "255.255.255.0" (Eingabe auch "/24") */
  subnet: string;
  gateway: string;
  dns1: string;
  dns2: string;
}

/** Vorschau vor dem Anwenden (Bestätigungsdialog) */
export interface IpProfilePreview {
  profile: string;
  adapter: string;
  mac: string;
  from: string;
  to: string;
  commands: string[];
  notes: string[];
}

/** Event "ip-profile": Sicherheitsnetz nach dem Anwenden */
export interface IpProfileEvent {
  phase: "pending" | "kept" | "reverting" | "reverted" | "failed";
  /** nur bei "pending": Sekunden bis zur automatischen Wiederherstellung */
  seconds: number | null;
  message: string;
  ok: boolean;
}

export interface AutostartStatus {
  supported: boolean;
  enabled: boolean;
  /** Eintrag zeigt auf eine andere net-conf.exe */
  otherPath: boolean;
}
