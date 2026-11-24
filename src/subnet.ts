// Subnetz-Rechner (Werkzeuge → Subnetz) – reine Logik ohne DOM, getestet in
// scripts/subnet.test.ts.
//
// ACHTUNG JavaScript: Bit-Operatoren (&, |, ~, <<) rechnen mit 32-Bit-Zahlen
// MIT Vorzeichen. 255.255.255.0 wäre sonst -256. Deshalb steht hinter jeder
// Bit-Operation ">>> 0" – das macht daraus wieder eine Zahl 0 … 4294967295.
// Und: "x << 32" ist in JS dasselbe wie "x << 0" (nur die unteren 5 Bit der
// Schiebeweite zählen) – darum wird Präfix 0 extra behandelt.
// Grössen wie 2^32 rechnen wir mit "2 ** n" (normale Zahl, kein Bit-Operator).
import { intToIp, ipToInt } from "./netutil.ts";

export interface SubnetInfo {
  ip: number;
  prefix: number;
  mask: number;
  wildcard: number;
  network: number;
  broadcast: number;
  /** null bei /32 ohne Host-Bereich? – nie: /32 = genau diese Adresse */
  first: number;
  last: number;
  /** nutzbare Host-Adressen */
  usable: number;
  /** alle Adressen im Netz */
  total: number;
  cls: "A" | "B" | "C" | "D" | "E";
  type: string;
  /** Hinweis zu Sonderfällen (/31, /32) */
  note: string | null;
}

/** Präfix (0–32) → Maske als vorzeichenlose Zahl */
export function prefixToMask(prefix: number): number {
  if (prefix <= 0) return 0;
  if (prefix >= 32) return 0xffff_ffff;
  return (0xffff_ffff << (32 - prefix)) >>> 0;
}

/** Maske → Präfix, null wenn die Einsen nicht zusammenhängen (z. B. 255.0.255.0) */
export function maskIntToPrefix(mask: number): number | null {
  const inv = ~mask >>> 0; // Hostanteil als Einsen, z. B. 0.0.0.255
  // zusammenhängend ⇔ inv hat die Form 0…01…1 ⇔ inv & (inv + 1) == 0
  if (((inv & (inv + 1)) >>> 0) !== 0) return null;
  let prefix = 0;
  for (let i = 31; i >= 0; i--) if ((mask >>> i) & 1) prefix++;
  return prefix;
}

/** Masken-Eingabe: "255.255.255.0", "/24" oder "24" → Präfix (oder Fehlermeldung) */
export function parseMask(raw: string): number | string {
  const s = raw.trim();
  const m = /^\/?(\d{1,2})$/.exec(s);
  if (m) {
    const p = Number(m[1]);
    return p <= 32 ? p : `/${p} gibt es nicht (erlaubt: /0 bis /32).`;
  }
  const n = ipToInt(s);
  if (n === null) return `„${s}“ ist keine gültige Subnetzmaske.`;
  const p = maskIntToPrefix(n);
  return p === null ? `${s} ist keine gültige Maske (Einsen müssen zusammenhängen, z. B. 255.255.255.0).` : p;
}

/**
 * Eingabe lesen: "192.168.10.55/24", "192.168.10.55 255.255.255.0",
 * "192.168.10.55/255.255.255.0" oder IP + separates Maskenfeld.
 * Ohne Maske: Klassen-Standard (A = /8, B = /16, C = /24), sonst /32.
 */
export function parseInput(text: string, maskText = ""): { ip: number; prefix: number; guessed: boolean } | { error: string } {
  const t = text.trim();
  if (!t) return { error: "Bitte eine IPv4-Adresse eingeben, z. B. 192.168.10.55/24." };
  const parts = t.split(/[\s/]+/).filter(Boolean);
  if (parts.length > 2) return { error: "Format: 192.168.10.55/24 oder 192.168.10.55 255.255.255.0" };
  const ip = ipToInt(parts[0]);
  if (ip === null) return { error: `„${parts[0]}“ ist keine gültige IPv4-Adresse.` };
  let maskPart = parts[1] ?? "";
  if (maskText.trim()) {
    if (maskPart) return { error: "Maske bitte nur an einer Stelle angeben (im Adressfeld ODER im Maskenfeld)." };
    maskPart = maskText.trim();
  }
  if (!maskPart) {
    const cls = addrClass(ip);
    const prefix = cls === "A" ? 8 : cls === "B" ? 16 : cls === "C" ? 24 : 32;
    return { ip, prefix, guessed: true };
  }
  const p = parseMask(maskPart);
  return typeof p === "string" ? { error: p } : { ip, prefix: p, guessed: false };
}

/** Adressklasse (historisch, nur nach dem ersten Oktett) */
export function addrClass(ip: number): SubnetInfo["cls"] {
  const a = ip >>> 24;
  if (a < 128) return "A";
  if (a < 192) return "B";
  if (a < 224) return "C";
  if (a < 240) return "D";
  return "E";
}

/** Liegt `ip` in `net/prefix`? */
export function inNet(ip: number, net: number, prefix: number): boolean {
  const mask = prefixToMask(prefix);
  return ((ip & mask) >>> 0) === ((net & mask) >>> 0);
}

/** Art der Adresse (privat, öffentlich, APIPA, …) */
export function addrType(ip: number): string {
  const p = (net: string, prefix: number) => inNet(ip, ipToInt(net)!, prefix);
  if (ip === 0xffff_ffff) return "Broadcast (lokal)";
  if (p("0.0.0.0", 8)) return "Dieses Netz (0.0.0.0/8)";
  if (p("127.0.0.0", 8)) return "Loopback";
  if (p("169.254.0.0", 16)) return "APIPA / Link-Local";
  if (p("10.0.0.0", 8) || p("172.16.0.0", 12) || p("192.168.0.0", 16)) return "privat (RFC 1918)";
  if (p("100.64.0.0", 10)) return "Carrier-Grade NAT (RFC 6598)";
  if (p("192.0.2.0", 24) || p("198.51.100.0", 24) || p("203.0.113.0", 24)) return "Dokumentation (TEST-NET)";
  if (p("224.0.0.0", 4)) return "Multicast";
  if (p("240.0.0.0", 4)) return "reserviert";
  return "öffentlich";
}

/** Alles berechnen. /31 (RFC 3021) und /32 sind Sonderfälle. */
export function calc(ip: number, prefix: number): SubnetInfo {
  const mask = prefixToMask(prefix);
  const wildcard = ~mask >>> 0;
  const network = (ip & mask) >>> 0;
  const broadcast = (network | wildcard) >>> 0;
  const total = 2 ** (32 - prefix);
  let first = network;
  let last = broadcast;
  let usable = total;
  let note: string | null = null;
  if (prefix === 32) {
    note = "/32: genau eine Adresse (Host-Route), kein Netz-/Broadcast-Anteil.";
    usable = 1;
  } else if (prefix === 31) {
    note = "/31 (RFC 3021): Punkt-zu-Punkt-Verbindung, beide Adressen sind nutzbar.";
    usable = 2;
  } else {
    first = network + 1;
    last = broadcast - 1;
    usable = total - 2;
  }
  return { ip, prefix, mask, wildcard, network, broadcast, first, last, usable, total, cls: addrClass(ip), type: addrType(ip), note };
}

/** Kleinstes Netz (grösstes Präfix), in das `hosts` Geräte passen – klassisch 2^n − 2, also höchstens /30. */
export function hostsToPrefix(hosts: number): number | null {
  if (!Number.isInteger(hosts) || hosts < 1) return null;
  for (let p = 30; p >= 0; p--) if (2 ** (32 - p) - 2 >= hosts) return p;
  return null;
}

export interface SplitResult {
  prefix: number;
  /** Anzahl Subnetze insgesamt */
  count: number;
  /** Netzadressen der ersten `limit` Subnetze */
  networks: number[];
}

/** Netz `network/prefix` in Subnetze mit Präfix `newPrefix` teilen (höchstens `limit` auflisten). */
export function split(network: number, prefix: number, newPrefix: number, limit = 256): SplitResult | string {
  if (newPrefix < prefix) return `/${newPrefix} ist grösser als das Ausgangsnetz /${prefix}.`;
  if (newPrefix > 32) return "Mehr als /32 geht nicht.";
  const base = (network & prefixToMask(prefix)) >>> 0;
  const count = 2 ** (newPrefix - prefix);
  const size = 2 ** (32 - newPrefix);
  const networks: number[] = [];
  for (let i = 0; i < Math.min(count, limit); i++) networks.push(base + i * size);
  return { prefix: newPrefix, count, networks };
}

/** In `count` gleich grosse Subnetze teilen (count muss eine Zweierpotenz sein). */
export function splitByCount(network: number, prefix: number, count: number, limit = 256): SplitResult | string {
  const bits = Math.log2(count);
  if (!Number.isInteger(bits) || count < 2) return "Die Anzahl muss eine Zweierpotenz sein (2, 4, 8, 16 …).";
  if (prefix + bits > 32) return `/${prefix} lässt sich nicht in ${count} Subnetze teilen.`;
  return split(network, prefix, prefix + bits, limit);
}

/** Subnetze, die jeweils mindestens `hosts` Geräte fassen. */
export function splitByHosts(network: number, prefix: number, hosts: number, limit = 256): SplitResult | string {
  const p = hostsToPrefix(hosts);
  if (p === null) return "Bitte eine Hostanzahl ab 1 eingeben.";
  if (p < prefix) {
    return `${hosts} Hosts brauchen mindestens /${p} – das ist grösser als das Ausgangsnetz /${prefix}.`;
  }
  return split(network, prefix, p, limit);
}

/** 32 Bit als "11000000.10101000.00001010.00110111" */
export function toBinary(n: number): string {
  const s = (n >>> 0).toString(2).padStart(32, "0");
  return [s.slice(0, 8), s.slice(8, 16), s.slice(16, 24), s.slice(24)].join(".");
}

/** Bequem: Zahl → "a.b.c.d" */
export const ip = intToIp;
