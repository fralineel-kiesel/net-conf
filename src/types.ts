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

/** Whitelist der Befehle – entspricht `NetCommand` in runner.rs. */
export type NetCommand =
  | { kind: "release"; adapter: string | null }
  | { kind: "renew"; adapter: string | null }
  | { kind: "flushDns" }
  | { kind: "registerDns" }
  | { kind: "ping"; target: string; count: number | null };

export interface StartedEvent {
  runId: number;
  commandLine: string;
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
}
