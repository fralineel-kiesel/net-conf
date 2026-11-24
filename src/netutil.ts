// Reine Hilfsfunktionen rund um IPv4 und Adapter – ohne DOM und ohne Tauri,
// damit sie auch in den Node-Tests (npm test) laufen.
import type { AdapterInfo, Ipv4Entry } from "./types";

/** "192.168.1.42" → Zahl (oder null, wenn ungültig) */
export function ipToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((x) => x > 255)) return null;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

export function intToIp(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

export const isIpv4 = (s: string) => ipToInt(s) !== null;

/** 169.254.x.x = APIPA: Windows hat sich selbst eine Adresse gegeben (DHCP gescheitert). */
export const isApipa = (ip: string) => ip.startsWith("169.254.");

/** Subnetzmaske → Präfixlänge, z. B. 255.255.255.0 → 24 (null bei Lücken) */
export function maskToPrefix(mask: string): number | null {
  const m = ipToInt(mask);
  if (m === null) return null;
  let prefix = 0;
  while (prefix < 32 && m & (0x8000_0000 >>> prefix)) prefix++;
  // Nach den Einsen dürfen nur Nullen kommen
  const rest = prefix === 32 ? 0 : (m << prefix) >>> 0;
  return rest === 0 ? prefix : null;
}

/** "192.168.1.0/24" */
export function networkOf(e: Ipv4Entry): string | null {
  const ip = ipToInt(e.address);
  const prefix = maskToPrefix(e.subnetMask);
  if (ip === null || prefix === null) return null;
  const mask = prefix === 0 ? 0 : (0xffff_ffff << (32 - prefix)) >>> 0;
  return `${intToIp((ip & mask) >>> 0)}/${prefix}`;
}

/** Privat (RFC 1918) oder Link-Local? – gleiche Regel wie lan.rs */
export function isAllowedNet(ip: string): boolean {
  const n = ipToInt(ip);
  if (n === null) return false;
  const a = n >>> 24;
  const b = (n >>> 16) & 255;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/** Warum darf dieses Netz nicht gescannt werden? null = erlaubt. (Das Backend prüft selbst noch einmal.) */
export function scanBlockReason(e: Ipv4Entry): string | null {
  const prefix = maskToPrefix(e.subnetMask);
  if (!isAllowedNet(e.address)) return "kein privates Netz";
  if (prefix === null) return "ungültige Maske";
  if (prefix < 22) return `/${prefix} zu gross (max. /22)`;
  if (prefix > 30) return "keine weiteren Geräte";
  return null;
}

/** Anzahl Host-Adressen eines Präfixes (ohne Netz/Broadcast) */
export const hostCount = (prefix: number) => (prefix >= 31 ? 0 : 2 ** (32 - prefix) - 2);

const byName = (x: AdapterInfo, y: AdapterInfo) =>
  x.name.localeCompare(y.name, "de", { sensitivity: "base" }) || x.id.localeCompare(y.id);

/**
 * Primärer Adapter = verbunden und mit Standardgateway (IPv4 bevorzugt).
 * Gibt es mehrere, entscheidet der Name – so ist das Ergebnis stabil.
 */
export function primaryOf(list: AdapterInfo[]): AdapterInfo | undefined {
  const connected = list.filter((a) => a.connected).sort(byName);
  return connected.find((a) => a.gateways.some(isIpv4)) ?? connected.find((a) => a.gateways.length > 0);
}

/** IPv4-Gateway eines Adapters (erstes) */
export const ipv4Gateway = (a: AdapterInfo | undefined) => a?.gateways.find(isIpv4);

/** IPv4-DNS-Server eines Adapters */
export const ipv4Dns = (a: AdapterInfo | undefined) => a?.dnsServers.filter(isIpv4) ?? [];

/** IP-Adressen numerisch vergleichen (192.168.1.9 vor 192.168.1.10) */
export function compareIp(a: string, b: string): number {
  return (ipToInt(a) ?? 0) - (ipToInt(b) ?? 0);
}

/** "AA-BB-..." mit gesetztem Bit "lokal verwaltet" = meist zufällige (private) MAC, z. B. Handys */
export function isRandomMac(mac: string): boolean {
  const first = parseInt(mac.slice(0, 2), 16);
  return Number.isFinite(first) && (first & 0x02) !== 0;
}

/** MAC prüfen (Komfort fürs Formular – verbindlich prüft das Backend). Gibt "AA-BB-…" oder null zurück. */
export function normalizeMac(raw: string): string | null {
  const s = raw.trim();
  let hex: string;
  if (/^[0-9a-fA-F]{12}$/.test(s)) hex = s;
  else if (/^([0-9a-fA-F]{2}-){5}[0-9a-fA-F]{2}$/.test(s) || /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/.test(s)) {
    hex = s.replace(/[-:]/g, "");
  } else return null;
  const up = hex.toUpperCase();
  if (up === "000000000000" || up === "FFFFFFFFFFFF") return null;
  if (parseInt(up.slice(0, 2), 16) & 1) return null; // Multicast
  return up.match(/../g)!.join("-");
}
