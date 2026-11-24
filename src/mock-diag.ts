// Mock für Phase 4a (Health-Check, Monitor, LAN-Scan, WoL, config.json) – nur im Browser.
//
// URL-Parameter für den Health-Check (Fehlerfälle durchspielen):
//   ?net=offline    kein Adapter verbunden
//   ?net=apipa      WLAN hat 169.254.x.x (DHCP gescheitert)
//   ?net=nogateway  Router antwortet nicht, kein Internet
//   ?net=dnsfail    Internet per IP ok, Namensauflösung scheitert
//   ?net=noicmp     Router/DNS/1.1.1.1 blockieren Ping, DNS klappt
import { events } from "./events";
import { getAdapters } from "./mock";
import { hostCount, ipToInt, intToIp, maskToPrefix, normalizeMac, scanBlockReason } from "./netutil";
import {
  MAX_MONITOR_TARGETS,
  MONITOR_INTERVALS,
  type AppConfig,
  type ConfigLoadResult,
  type LanHost,
  type MonitorLogEntry,
  type MonitorStatus,
  type MonitorTarget,
  type MonitorTargetView,
  type PingResult,
  type ResolveResult,
  type ScanStarted,
  type WolResult,
} from "./types";
import { validateTarget } from "./validate";
import { checkProfile, MAX_PROFILES, normalizeSubnet } from "./ipprofile";

export const scenario = new URLSearchParams(location.search).get("net") ?? "";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (base: number, spread: number) => Math.max(0, Math.round(base + Math.random() * spread));

// ---- Ping und Namensauflösung ------------------------------------------------

/** Geräte, die per WoL "geweckt" wurden: MAC → Zeitpunkt, ab dem sie antworten */
const wakeAt = new Map<string, number>();
const NAS_IP = "192.168.1.20";
const NAS_MAC = "B8-27-EB-44-55-66";

/** Simulierte Latenz eines Ziels oder null (keine Antwort). */
function simulatedRtt(ip: string, round = 0): number | null {
  if (scenario === "nogateway" || scenario === "offline" || scenario === "apipa") return null;
  if (scenario === "noicmp" && ["192.168.1.1", "1.1.1.1", "8.8.8.8"].includes(ip)) return null;
  if (ip === NAS_IP) {
    const t = wakeAt.get(NAS_MAC);
    return t !== undefined && Date.now() >= t ? jitter(1, 2) : null;
  }
  if (ip.startsWith("10.99.")) return null; // gibt es nicht
  if (ip === "192.168.1.1") return jitter(2, 3);
  if (ip === "1.1.1.1") return jitter(11, 5);
  // 8.8.8.8 fällt im Monitor regelmässig kurz aus (für das Ausfall-Log)
  if (ip === "8.8.8.8") return round % 40 >= 10 && round % 40 < 18 ? null : jitter(14, 8);
  if (ip.startsWith("192.168.1.")) return jitter(3, 6);
  return jitter(18, 15);
}

function mockResolve(target: string): string {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(target)) return target;
  if (target.endsWith(".invalid")) throw `Der Name „${target}“ konnte nicht aufgelöst werden.`;
  if (target.includes(":")) throw "IPv6-Adressen werden hier nicht unterstützt (nur IPv4).";
  return "142.250.185.78";
}

export async function icmpPing(target: string, timeoutMs: number): Promise<PingResult> {
  const err = validateTarget(target);
  if (err) throw err;
  const address = mockResolve(target.trim());
  const rtt = simulatedRtt(address);
  await delay(rtt === null ? Math.min(timeoutMs, 600) : 40 + rtt);
  return rtt === null
    ? { address, status: "timeout", rttMs: null, ttl: null, message: null }
    : { address, status: "ok", rttMs: rtt, ttl: address.startsWith("192.168.") ? 64 : 57, message: null };
}

export async function resolveName(name: string, timeoutMs: number): Promise<ResolveResult> {
  if (scenario === "dnsfail" || scenario === "nogateway") {
    await delay(Math.min(timeoutMs, 900));
    throw `Zeitüberschreitung bei der Namensauflösung von „${name}“ (${timeoutMs / 1000} s).`;
  }
  await delay(120);
  return { addresses: ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"], elapsedMs: jitter(18, 20) };
}

// ---- config.json (im Browser: localStorage) ------------------------------------

const CONFIG_KEY = "netconf.mockConfig";
const DEFAULT_CONFIG: AppConfig = {
  version: 1,
  monitorTargets: [
    { name: "Router", host: "192.168.1.1" },
    { name: "Cloudflare", host: "1.1.1.1" },
    { name: "Google DNS", host: "8.8.8.8" },
    { name: "Testnetz", host: "10.99.0.1" },
  ],
  monitorIntervalSec: 1,
  wolDevices: [
    { name: "NAS Keller", mac: NAS_MAC, ip: NAS_IP, note: "Synology, WoL im BIOS aktiv" },
    { name: "Gaming-PC", mac: "2C-F0-5D-AA-BB-CC", ip: null, note: "" },
  ],
  ipProfiles: [
    { name: "Zuhause (DHCP)", adapter: "WLAN", mac: "A4-C3-F0-12-34-56", mode: "dhcp", ipv4: "", subnet: "", gateway: "", dns1: "", dns2: "" },
    { name: "Labor statisch", adapter: "WLAN", mac: "A4-C3-F0-12-34-56", mode: "static", ipv4: "192.168.1.50", subnet: "255.255.255.0", gateway: "192.168.1.1", dns1: "1.1.1.1", dns2: "8.8.8.8" },
    { name: "Switch-Konfig", adapter: "Ethernet", mac: "D8-BB-C1-98-76-54", mode: "static", ipv4: "192.168.0.10", subnet: "255.255.255.0", gateway: "", dns1: "", dns2: "" },
  ],
  closeToTray: false,
};

export async function loadConfig(): Promise<ConfigLoadResult> {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    // Ältere Mock-Daten ohne die neuen Felder mit Standardwerten auffüllen (wie serde "default")
    const cfg = raw ? { ...structuredClone(DEFAULT_CONFIG), ...(JSON.parse(raw) as Partial<AppConfig>) } : structuredClone(DEFAULT_CONFIG);
    return { config: cfg, notice: null, path: "localStorage (Mock)" };
  } catch {
    return { config: structuredClone(DEFAULT_CONFIG), notice: "config.json war beschädigt – Standardwerte aktiv. (Mock)", path: "localStorage (Mock)" };
  }
}

/** Prüft wie config.rs (vereinfacht) und speichert. */
export async function saveConfig(cfg: AppConfig): Promise<AppConfig> {
  if (cfg.monitorTargets.length > MAX_MONITOR_TARGETS) throw `Höchstens ${MAX_MONITOR_TARGETS} Monitor-Ziele.`;
  if (!(MONITOR_INTERVALS as readonly number[]).includes(cfg.monitorIntervalSec)) throw "Ungültiges Intervall (erlaubt: 1, 2, 5, 10 s).";
  const clean: AppConfig = {
    version: 1,
    monitorIntervalSec: cfg.monitorIntervalSec,
    monitorTargets: cfg.monitorTargets.map((t) => {
      const err = validateTarget(t.host);
      if (err) throw err;
      return { name: t.name.trim() || t.host.trim(), host: t.host.trim() };
    }),
    wolDevices: cfg.wolDevices.map((d) => {
      const mac = normalizeMac(d.mac);
      if (!mac) throw `„${d.mac}“ ist keine gültige MAC-Adresse. Beispiel: AA-BB-CC-DD-EE-FF`;
      if (!d.name.trim()) throw "WoL-Gerät: Bitte einen Namen eingeben.";
      if (d.name.trim().length > 40) throw "WoL-Gerät: Der Name ist zu lang (max. 40 Zeichen).";
      const ip = d.ip?.trim() || null;
      if (ip && ipToInt(ip) === null) throw `„${ip}“ ist keine gültige IPv4-Adresse.`;
      if (d.note.trim().length > 120) throw "Die Notiz ist zu lang (max. 120 Zeichen).";
      return { name: d.name.trim(), mac, ip, note: d.note.trim() };
    }),
    ipProfiles: cfg.ipProfiles.map((p, i) => {
      const err = checkProfile(p);
      if (err) throw err;
      if (cfg.ipProfiles.slice(0, i).some((q) => q.name.trim().toLowerCase() === p.name.trim().toLowerCase())) {
        throw `Es gibt schon ein IP-Profil „${p.name.trim()}“.`;
      }
      const dhcp = p.mode === "dhcp";
      return {
        ...p,
        name: p.name.trim(),
        ipv4: dhcp ? "" : p.ipv4.trim(),
        subnet: dhcp ? "" : normalizeSubnet(p.subnet),
        gateway: dhcp ? "" : p.gateway.trim(),
        dns1: p.dns1.trim(),
        dns2: p.dns2.trim(),
      };
    }),
    closeToTray: cfg.closeToTray === true,
  };
  if (clean.ipProfiles.length > MAX_PROFILES) throw `Höchstens ${MAX_PROFILES} IP-Profile.`;
  await delay(30);
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(clean));
  } catch {
    /* egal */
  }
  return clean;
}

// ---- Ping-Monitor (gleiche Logik wie monitor.rs) ----------------------------------

interface MockTarget {
  view: MonitorTargetView;
  sum: number;
  failStreak: number;
}
const mon = { running: false, intervalSec: 2, targets: [] as MockTarget[], log: [] as MonitorLogEntry[], timer: 0, round: 0 };

const newTarget = (t: MonitorTarget): MockTarget => ({
  view: { name: t.name, host: t.host, address: null, status: "unknown", lastMs: null, avgMs: null, sent: 0, received: 0, lossPercent: 0, history: [], sinceMs: null, error: null },
  sum: 0,
  failStreak: 0,
});

const monStatus = (): MonitorStatus => ({
  running: mon.running,
  intervalSec: mon.intervalSec,
  targets: mon.targets.map((t) => structuredClone(t.view)),
  log: [...mon.log],
});

function emitMon(newLog: MonitorLogEntry[] = []): void {
  const s = monStatus();
  events.monitor.emit({ running: s.running, intervalSec: s.intervalSec, targets: s.targets, newLog });
}

function monRound(): void {
  mon.round++;
  const now = Date.now();
  const newLog: MonitorLogEntry[] = [];
  for (const t of mon.targets) {
    const v = t.view;
    let ip: string;
    try {
      ip = mockResolve(v.host);
    } catch (e) {
      v.error = String(e);
      ip = "";
    }
    v.address = ip || null;
    const rtt = ip ? simulatedRtt(ip, mon.round) : null;
    v.sent++;
    v.history = [...v.history.slice(-119), rtt];
    v.lastMs = rtt;
    if (rtt !== null) {
      v.received++;
      t.sum += rtt;
      t.failStreak = 0;
      if (v.status !== "up") {
        if (v.status === "down") {
          newLog.push({ timeMs: now, name: v.name, host: v.host, kind: "up", afterSec: Math.floor((now - (v.sinceMs ?? now)) / 1000) });
        }
        v.status = "up";
        v.sinceMs = now;
      }
    } else if (++t.failStreak >= 2 && v.status !== "down") {
      v.status = "down";
      v.sinceMs = now;
      newLog.push({ timeMs: now, name: v.name, host: v.host, kind: "down", afterSec: null });
    }
    v.avgMs = v.received ? Math.round(t.sum / v.received) : null;
    v.lossPercent = Math.round(((v.sent - v.received) * 1000) / v.sent) / 10;
  }
  mon.log = [...mon.log, ...newLog].slice(-500);
  emitMon(newLog);
}

export async function monitorSet(targets: MonitorTarget[], intervalSec: number): Promise<MonitorStatus> {
  if (targets.length > MAX_MONITOR_TARGETS) throw `Höchstens ${MAX_MONITOR_TARGETS} Ziele.`;
  for (const t of targets) {
    const err = validateTarget(t.host);
    if (err) throw err;
  }
  const old = mon.targets;
  mon.targets = targets.map((t) => old.find((o) => o.view.name === t.name && o.view.host === t.host) ?? newTarget(t));
  if (mon.intervalSec !== intervalSec && mon.running) {
    clearInterval(mon.timer);
    mon.timer = window.setInterval(monRound, intervalSec * 1000);
  }
  mon.intervalSec = intervalSec;
  emitMon();
  return monStatus();
}

export async function monitorStart(): Promise<MonitorStatus> {
  if (mon.targets.length === 0) throw "Bitte zuerst mindestens ein Ziel hinzufügen.";
  if (!mon.running) {
    mon.running = true;
    mon.round = 0;
    mon.targets = mon.targets.map((t) => newTarget({ name: t.view.name, host: t.view.host }));
    mon.timer = window.setInterval(monRound, mon.intervalSec * 1000);
    setTimeout(monRound, 50);
  }
  emitMon();
  return monStatus();
}

export async function monitorStop(): Promise<MonitorStatus> {
  mon.running = false;
  clearInterval(mon.timer);
  emitMon();
  return monStatus();
}

export async function monitorStatus(): Promise<MonitorStatus> {
  return monStatus();
}

export async function monitorClearLog(): Promise<void> {
  mon.log = [];
}

// ---- LAN-Scan --------------------------------------------------------------------

/** Erfundene Geräte im Mock-Netz 192.168.1.0/24: [Endziffer, MAC, Name, Latenz] */
const LAN_DEVICES: [number, string, string | null, number | null][] = [
  [1, "3C-A6-2F-11-22-33", "fritz.box", 1],
  [5, "00-11-32-AB-CD-EF", "drucker-buero.fritz.box", 4],
  [12, "DA-A1-19-5E-77-01", null, 38], // zufällige MAC (Handy)
  [20, NAS_MAC, "nas-keller.fritz.box", null], // schläft: antwortet auf ARP, nicht auf Ping
  [23, "F0-9F-C2-10-20-30", "unifi-ap.fritz.box", 2],
  [42, "A4-C3-F0-12-34-56", "desktop-mock42.fritz.box", 0],
  [77, "B0-BE-76-01-02-03", "tv-wohnzimmer.fritz.box", 9],
  [108, "AC-DE-48-00-11-22", null, 6],
  [150, "2C-F0-5D-AA-BB-CC", "gaming-pc.fritz.box", 3],
];
const lan = { scanId: -1, cancelled: false, running: false };

export async function lanScanStart(scanId: number, adapter: string, address: string): Promise<ScanStarted> {
  const a = (await getAdapters()).find((x) => x.name === adapter);
  if (!a) throw `Adapter "${adapter}" wurde nicht gefunden.`;
  if (!a.connected) throw `Der Adapter "${adapter}" ist nicht verbunden.`;
  const entry = a.ipv4.find((e) => e.address === address);
  if (!entry) throw `Die Adresse ${address} gehört nicht zum Adapter "${adapter}".`;
  const reason = scanBlockReason(entry);
  if (reason) throw `Dieses Netz wird nicht gescannt: ${reason}.`;
  if (lan.running) throw "Es läuft bereits ein Scan.";
  const prefix = maskToPrefix(entry.subnetMask)!;
  const total = hostCount(prefix);
  const net = (ipToInt(address)! & ((0xffff_ffff << (32 - prefix)) >>> 0)) >>> 0;
  Object.assign(lan, { scanId, cancelled: false, running: true });

  void (async () => {
    const start = Date.now();
    let found = 0;
    for (let i = 1; i <= total; i++) {
      if (lan.cancelled) break;
      if (i % 8 === 0) await delay(60); // ca. 2 s für ein /24
      const ip = intToIp(net + i);
      const dev = ipToInt(address)! >>> 8 === 0xc0a801 ? LAN_DEVICES.find((d) => d[0] === i) : undefined;
      if (dev) {
        found++;
        const host: LanHost = { ip, mac: dev[1], latencyMs: null, hostname: null, pending: true };
        events.lanHost.emit({ scanId, host: { ...host } });
        // Name und Latenz kommen etwas später ("wird nachträglich gefüllt")
        setTimeout(() => events.lanHost.emit({ scanId, host: { ...host, latencyMs: dev[3], hostname: dev[2], pending: false } }), 700);
      }
      events.lanProgress.emit({ scanId, done: i, total });
    }
    await delay(750);
    lan.running = false;
    events.lanFinished.emit({ scanId, cancelled: lan.cancelled, found, elapsedMs: Date.now() - start });
  })();

  return { network: `${intToIp(net)}/${prefix}`, total };
}

export async function lanScanCancel(): Promise<void> {
  lan.cancelled = true;
}

// ---- Wake-on-LAN -----------------------------------------------------------------

export async function wolSend(mac: string, adapter: string, address: string): Promise<WolResult> {
  const norm = normalizeMac(mac);
  if (!norm) throw `„${mac}“ ist keine gültige MAC-Adresse. Beispiel: AA-BB-CC-DD-EE-FF`;
  const a = (await getAdapters()).find((x) => x.name === adapter);
  const entry = a?.ipv4.find((e) => e.address === address);
  if (!a || !entry) throw `Adapter "${adapter}" wurde nicht gefunden.`;
  // Das NAS "wacht" nach 9 s auf
  if (norm === NAS_MAC) wakeAt.set(NAS_MAC, Date.now() + 9000);
  const prefix = maskToPrefix(entry.subnetMask) ?? 24;
  const bcast = intToIp((ipToInt(address)! | (0xffff_ffff >>> prefix)) >>> 0);
  await delay(40);
  return { mac: norm, sentTo: [`${bcast}:9`, "255.255.255.255:9"] };
}
