// Reine Helfer für die Seite "Traffic": Formatierung der Raten und Filter/
// Sortierung der Verbindungsliste. Ohne DOM → läuft in den Node-Tests (npm test).
//
// Einheiten: dezimal wie bei Netzwerken üblich (1 Mbit/s = 1 000 000 bit/s,
// 1 MB = 1 000 000 Byte). Dezimalpunkt wie in der Schweiz (12.5).
import { ipToInt } from "./netutil.ts";
import type { Connection } from "./types";

/** Zahl mit passender Genauigkeit: < 10 → 2 Stellen, < 100 → 1 Stelle, sonst ganz */
function num(v: number): string {
  if (v < 10) return v.toFixed(2);
  if (v < 100) return v.toFixed(1);
  return Math.round(v).toString();
}

/** bit/s → "12.4 Mbit/s" */
export const fmtMbit = (bps: number) => `${num(bps / 1e6)} Mbit/s`;

/** bit/s → "1.55 MB/s" */
export const fmtMByteRate = (bps: number) => `${num(bps / 8 / 1e6)} MB/s`;

/** Bytes → "12.3 MB" bzw. "1.23 GB" */
export function fmtBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

/** Link-Geschwindigkeit: "1 Gbit/s", "2.5 Gbit/s", "866.7 Mbit/s" */
export function fmtLink(bps: number): string {
  const trim = (s: string) => s.replace(/\.0+$/, "");
  if (bps >= 1e9) return `${trim((bps / 1e9).toFixed(1))} Gbit/s`;
  return `${trim((bps / 1e6).toFixed(1))} Mbit/s`;
}

/** Dauer in Sekunden → "1 h 02 min", "3 min 05 s", "12 s" */
export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (h > 0) return `${h} h ${pad(m)} min`;
  if (m > 0) return `${m} min ${pad(s % 60)} s`;
  return `${s} s`;
}

// ---- Verbindungen ----------------------------------------------------------

export type ConnFilter = "all" | "listen" | "established";
export type ConnSortKey = "proto" | "local" | "remote" | "state" | "pid" | "process";

/** Höchstens so viele Zeilen zeichnen (sonst wird die Seite träge) */
export const MAX_CONN_ROWS = 500;

/** "192.168.1.42:443" bzw. "[fe80::1]:443"; UDP ohne Gegenstelle → "*:*" */
export function endpoint(addr: string, port: number, family: 4 | 6): string {
  if (!addr) return "*:*";
  return family === 6 ? `[${addr}]:${port}` : `${addr}:${port}`;
}

/** Hat die Zeile eine echte Gegenstelle (für [ Auflösen ])? */
export function hasRemote(c: Connection): boolean {
  if (!c.remoteAddr || c.state === "LISTEN") return false;
  return c.remoteAddr !== "0.0.0.0" && c.remoteAddr !== "::";
}

/** Zustand-Filter: LISTEN zeigt auch UDP (gebundene Ports "lauschen" ebenfalls). */
export function matchesFilter(c: Connection, filter: ConnFilter, text: string): boolean {
  if (filter === "listen" && !(c.state === "LISTEN" || c.proto === "UDP")) return false;
  if (filter === "established" && c.state !== "ESTABLISHED") return false;
  const q = text.trim().toLowerCase();
  if (!q) return true;
  const fields = [
    c.proto,
    endpoint(c.localAddr, c.localPort, c.family),
    endpoint(c.remoteAddr, c.remotePort, c.family),
    c.state,
    String(c.pid),
    c.process,
  ];
  return fields.some((f) => f.toLowerCase().includes(q));
}

/** Adressen sinnvoll vergleichen: IPv4 numerisch, dann IPv6 als Text, dann Port */
function compareAddr(a: string, ap: number, b: string, bp: number): number {
  const ia = ipToInt(a);
  const ib = ipToInt(b);
  if (ia !== null && ib !== null && ia !== ib) return ia - ib;
  if ((ia === null) !== (ib === null)) return ia === null ? 1 : -1; // IPv4 vor IPv6/leer
  if (ia === null && a !== b) return a.localeCompare(b);
  return ap - bp;
}

export function sortConnections(rows: Connection[], key: ConnSortKey, dir: "asc" | "desc"): Connection[] {
  const cmp = (x: Connection, y: Connection): number => {
    switch (key) {
      case "proto":
        return x.proto.localeCompare(y.proto) || x.family - y.family;
      case "local":
        return compareAddr(x.localAddr, x.localPort, y.localAddr, y.localPort);
      case "remote":
        return compareAddr(x.remoteAddr, x.remotePort, y.remoteAddr, y.remotePort);
      case "state":
        return x.state.localeCompare(y.state);
      case "pid":
        return x.pid - y.pid;
      case "process":
        return x.process.localeCompare(y.process, "de", { sensitivity: "base" });
    }
  };
  // Bei Gleichstand stabil nach lokaler Adresse, damit nichts "springt"
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort(
    (x, y) => sign * cmp(x, y) || compareAddr(x.localAddr, x.localPort, y.localAddr, y.localPort),
  );
}
