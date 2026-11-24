// IP-Profile – reine Helfer ohne DOM (Formular-Prüfung, Beschreibung).
// Die verbindliche Prüfung macht das Backend (ipprofile.rs); hier ist es nur
// Komfort für sofortige Rückmeldung – und die Grundlage für den Mock.
import { ipToInt } from "./netutil.ts";
import { inNet, parseMask, prefixToMask } from "./subnet.ts";
import type { AdapterInfo, IpProfile } from "./types.ts";

export const MAX_PROFILES = 50;

/** Gleiche Sperrliste wie special_reason() im Backend */
function specialReason(n: number): string | null {
  const a = n >>> 24;
  if (n === 0 || a === 0) return "ist keine gültige Host-Adresse (0.x.x.x)";
  if (n === 0xffff_ffff) return "ist die Broadcast-Adresse";
  if (a >= 224 && a < 240) return "ist eine Multicast-Adresse";
  if (a >= 240) return "liegt im reservierten Bereich 240.0.0.0/4";
  return null;
}

function hostError(n: number, prefix: number, what: string, text: string): string | null {
  const r = specialReason(n);
  if (r) return `${what}: ${text} ${r}.`;
  if (n >>> 24 === 127) return `${what}: ${text} ist eine Loopback-Adresse.`;
  if (prefix <= 30) {
    const mask = prefixToMask(prefix);
    const net = (n & mask) >>> 0;
    if (n === net) return `${what}: ${text} ist die Netzadresse dieses Subnetzes.`;
    if (n === (net | (~mask >>> 0)) >>> 0) return `${what}: ${text} ist die Broadcast-Adresse dieses Subnetzes.`;
  }
  return null;
}

/** Profil prüfen (wie das Backend). Gibt eine Fehlermeldung oder null zurück. */
export function checkProfile(p: IpProfile): string | null {
  const name = p.name.trim();
  if (!name) return "IP-Profil: Bitte einen Namen eingeben.";
  if ([...name].length > 40) return "IP-Profil: Der Name ist zu lang (max. 40 Zeichen).";
  if (!p.adapter) return "Bitte einen Adapter wählen.";
  if (p.mode === "static") {
    if (!p.ipv4.trim()) return "Bitte eine IPv4-Adresse eingeben.";
    if (!p.subnet.trim()) return "Bitte eine Subnetzmaske oder ein Präfix eingeben (z. B. 255.255.255.0 oder /24).";
    const ip = ipToInt(p.ipv4);
    if (ip === null || !/^\d+\.\d+\.\d+\.\d+$/.test(p.ipv4.trim()) || /(^|\.)0\d/.test(p.ipv4.trim())) {
      return `IPv4: „${p.ipv4.trim()}“ ist keine gültige IPv4-Adresse.`;
    }
    const prefix = parseMask(p.subnet);
    if (typeof prefix === "string") return prefix;
    if (prefix === 0) return "Subnetzmaske 0.0.0.0 ist ungültig.";
    const e = hostError(ip, prefix, "IPv4", p.ipv4.trim());
    if (e) return e;
    if (p.gateway.trim()) {
      const gw = ipToInt(p.gateway);
      if (gw === null) return `Gateway: „${p.gateway.trim()}“ ist keine gültige IPv4-Adresse.`;
      const ge = hostError(gw, prefix, "Gateway", p.gateway.trim());
      if (ge) return ge;
      if (!inNet(gw, ip, prefix)) return `Gateway ${p.gateway.trim()} liegt nicht im Subnetz der IP-Adresse (/${prefix}).`;
      if (gw === ip) return "Das Gateway darf nicht die eigene IP-Adresse sein.";
    }
  }
  const d1 = p.dns1.trim();
  const d2 = p.dns2.trim();
  if (!d1 && d2) return "DNS 2 ist nur zusammen mit DNS 1 möglich.";
  for (const [d, what] of [[d1, "DNS 1"], [d2, "DNS 2"]] as const) {
    if (!d) continue;
    const n = ipToInt(d);
    if (n === null) return `${what}: „${d}“ ist keine gültige IPv4-Adresse.`;
    const r = specialReason(n);
    if (r) return `${what}: ${d} ${r}.`;
  }
  if (d1 && d1 === d2) return "DNS 1 und DNS 2 sind gleich.";
  return null;
}

/** Maske normalisieren ("/24" → "255.255.255.0") – wie das Backend beim Speichern. */
export function normalizeSubnet(raw: string): string {
  const p = parseMask(raw);
  if (typeof p === "string") return raw.trim();
  const m = prefixToMask(p);
  return [m >>> 24, (m >>> 16) & 255, (m >>> 8) & 255, m & 255].join(".");
}

/** Kurzbeschreibung wie describe() im Backend: "statisch 192.168.1.50/24, Gateway …, DNS …" */
export function describeProfile(p: IpProfile): string {
  let addr = "DHCP";
  if (p.mode === "static") {
    const prefix = parseMask(p.subnet);
    const gw = p.gateway.trim() ? `Gateway ${p.gateway.trim()}` : "kein Gateway";
    addr = `statisch ${p.ipv4.trim()}/${typeof prefix === "number" ? prefix : "?"}, ${gw}`;
  }
  const dns = [p.dns1, p.dns2].map((d) => d.trim()).filter(Boolean);
  const dnsText = dns.length ? `DNS ${dns.join(", ")}` : p.mode === "dhcp" ? "DNS automatisch" : "kein DNS";
  return `${addr}, ${dnsText}`;
}

/** Profil aus dem aktuellen Zustand eines Adapters (Button „Aus aktuellem Adapter übernehmen“). */
export function profileFromAdapter(a: AdapterInfo, name: string): IpProfile {
  const v4 = a.ipv4[0];
  const dns = a.dnsServers.filter((d) => ipToInt(d) !== null);
  return {
    name,
    adapter: a.name,
    mac: a.mac,
    mode: a.dhcpEnabled ? "dhcp" : "static",
    ipv4: a.dhcpEnabled ? "" : (v4?.address ?? ""),
    subnet: a.dhcpEnabled ? "" : (v4?.subnetMask ?? ""),
    gateway: a.dhcpEnabled ? "" : (a.gateways.find((g) => ipToInt(g) !== null) ?? ""),
    // Bei DHCP sind die DNS-Server meist vom DHCP-Server – dann leer lassen (= automatisch)
    dns1: a.dhcpEnabled ? "" : (dns[0] ?? ""),
    dns2: a.dhcpEnabled ? "" : (dns[1] ?? ""),
  };
}

/** Leeres Profil für [ Neu ] */
export function emptyProfile(adapter: AdapterInfo | undefined): IpProfile {
  return { name: "", adapter: adapter?.name ?? "", mac: adapter?.mac ?? "", mode: "static", ipv4: "", subnet: "/24", gateway: "", dns1: "", dns2: "" };
}
