// Mock für Phase 4c (IP-Profile mit Sicherheitsnetz, Kompaktmodus, Autostart,
// Update-Check) – nur im Browser.
//
//   ?fail=address  „IP-Profil anwenden“ scheitert beim Adress-Schritt → sofortige Wiederherstellung
//   ?update=new    es gibt eine neuere Version (v9.9.0)
//   ?update=private | offline | ratelimit   Fehlerfälle beim Update-Check
import { events } from "./events";
import { describeProfile, normalizeSubnet } from "./ipprofile";
import { ADAPTERS } from "./mock";
import { loadConfig } from "./mock-diag";
import { maskToPrefix } from "./netutil";
import type { AdapterInfo, AutostartStatus, IpProfile, IpProfilePreview } from "./types";
import { interpretRelease, isReleaseUrl, RELEASES_URL, type ReleaseCheck } from "./update";

const params = new URLSearchParams(location.search);
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- IP-Profile ---------------------------------------------------------------

/** Fest eingetragene DNS-Server pro Adapter (im echten Backend: Registry) */
const dnsStatic = new Map<string, boolean>();
/** Werte, die der DHCP-Server liefern würde (Zustand beim Start). Erst beim ersten
 *  Gebrauch anlegen – mock.ts und diese Datei importieren sich gegenseitig. */
let dhcpCache: Map<string, AdapterInfo> | null = null;
const dhcpValues = () => (dhcpCache ??= new Map(ADAPTERS.map((a) => [a.id, structuredClone(a)])));

/** Aktueller Zustand eines Adapters als „Profil“ – zum Vergleichen und Wiederherstellen */
function currentOf(a: AdapterInfo): IpProfile {
  const v4 = a.ipv4[0];
  const dns = dnsStatic.get(a.id) ? a.dnsServers : [];
  return {
    name: "",
    adapter: a.name,
    mac: a.mac,
    mode: a.dhcpEnabled ? "dhcp" : "static",
    ipv4: a.dhcpEnabled ? "" : (v4?.address ?? ""),
    subnet: a.dhcpEnabled ? "" : (v4?.subnetMask ?? ""),
    gateway: a.dhcpEnabled ? "" : (a.gateways[0] ?? ""),
    dns1: dns[0] ?? "",
    dns2: dns[1] ?? "",
  };
}

const addrKey = (p: IpProfile) => (p.mode === "dhcp" ? "dhcp" : `${p.ipv4}|${normalizeSubnet(p.subnet)}|${p.gateway}`);
const dnsKey = (p: IpProfile) => (p.mode === "dhcp" && !p.dns1 ? "dhcp" : `static|${p.dns1}|${p.dns2}`);

/** Gleiche Befehle wie build_steps() in ipprofile.rs */
function steps(adapter: string, from: IpProfile, to: IpProfile): string[] {
  const q = adapter.includes(" ") ? `"${adapter}"` : adapter;
  const out: string[] = [];
  if (addrKey(from) !== addrKey(to)) {
    out.push(
      to.mode === "dhcp"
        ? `netsh interface ipv4 set address ${q} dhcp`
        : `netsh interface ipv4 set address ${q} static ${to.ipv4} ${normalizeSubnet(to.subnet)} ${to.gateway || "gateway=none"}`,
    );
  }
  if (dnsKey(from) !== dnsKey(to)) {
    if (dnsKey(to) === "dhcp") out.push(`netsh interface ipv4 set dnsservers ${q} dhcp`);
    else if (!to.dns1) out.push(`netsh interface ipv4 set dnsservers ${q} static none`);
    else {
      out.push(`netsh interface ipv4 set dnsservers ${q} static ${to.dns1} primary validate=no`);
      if (to.dns2) out.push(`netsh interface ipv4 add dnsservers ${q} ${to.dns2} index=2 validate=no`);
    }
  }
  return out;
}

/** Zustand in den Mock-Adapter schreiben (wie Windows nach netsh) */
function setAdapter(a: AdapterInfo, p: IpProfile): void {
  const dhcp = dhcpValues().get(a.id)!;
  a.dhcpEnabled = p.mode === "dhcp";
  if (p.mode === "dhcp") {
    a.ipv4 = structuredClone(dhcp.ipv4);
    a.gateways = [...dhcp.gateways];
    a.dhcpServer = dhcp.dhcpServer;
  } else {
    a.ipv4 = [{ address: p.ipv4, subnetMask: normalizeSubnet(p.subnet) }];
    a.gateways = p.gateway ? [p.gateway] : [];
    a.dhcpServer = null;
  }
  const staticDns = dnsKey(p) !== "dhcp";
  dnsStatic.set(a.id, staticDns);
  a.dnsServers = staticDns ? [p.dns1, p.dns2].filter(Boolean) : [...dhcp.dnsServers];
}

async function prepare(name: string): Promise<{ profile: IpProfile; adapter: AdapterInfo; from: IpProfile; cmds: string[] }> {
  dhcpValues(); // Ausgangszustand merken, bevor sich etwas ändert
  const { config } = await loadConfig();
  const profile = config.ipProfiles.find((p) => p.name === name);
  if (!profile) throw `IP-Profil „${name}“ wurde nicht gefunden (zuerst speichern).`;
  const adapter = ADAPTERS.find((a) => a.mac === profile.mac) ?? ADAPTERS.find((a) => !profile.mac && a.name === profile.adapter);
  if (!adapter) throw `Kein Adapter mit der MAC ${profile.mac} gefunden (Profil gehört zu „${profile.adapter}“).`;
  const from = currentOf(adapter);
  const cmds = steps(adapter.name, from, profile);
  if (!cmds.length) throw `„${adapter.name}“ hat bereits genau diese Konfiguration – nichts zu tun.`;
  return { profile, adapter, from, cmds };
}

const describeCurrent = (p: IpProfile) =>
  describeProfile(p.mode === "static" && maskToPrefix(p.subnet) === null ? { ...p, subnet: "/32" } : p);

export async function ipProfilePreview(name: string): Promise<IpProfilePreview> {
  await delay(80);
  const { profile, adapter, from, cmds } = await prepare(name);
  return { profile: profile.name, adapter: adapter.name, mac: adapter.mac, from: describeCurrent(from), to: describeProfile(profile), commands: cmds, notes: [] };
}

let busy = false;
let decide: ((keep: boolean) => void) | null = null;
let restoreId = 0xe000_0000;

/** Befehle wie im Backend nacheinander „ausführen“ (Konsole), Fehler per ?fail=… */
async function runSteps(runId: number, title: string, cmds: string[], keepGoing: boolean): Promise<boolean> {
  events.started.emit({ runId, commandLine: title });
  let failed: number | null = null;
  for (let i = 0; i < cmds.length; i++) {
    if (failed !== null && !keepGoing) break;
    if (cmds.length > 1) events.step.emit({ runId, index: i + 1, total: cmds.length, label: cmds[i], recovery: failed !== null });
    await delay(500);
    const fail = params.get("fail");
    if (fail && cmds[i].includes(fail) && title.startsWith("IP-Profil")) {
      events.output.emit({ runId, stream: "stdout", line: "Die Konfiguration ist ungültig. (Mock: ?fail=" + fail + ")" });
      failed ??= i + 1;
    }
  }
  events.finished.emit({ runId, exitCode: failed === null ? 0 : 1, cancelled: false, failedStep: failed, error: null });
  return failed === null;
}

export async function ipProfileApply(runId: number, name: string): Promise<void> {
  if (params.get("admin") !== "1") throw "Zum Anwenden eines IP-Profils werden Administratorrechte benötigt.";
  if (busy) throw "Es läuft bereits eine IP-Änderung.";
  const { profile, adapter, from, cmds } = await prepare(name);
  busy = true;
  void (async () => {
    const ok = await runSteps(runId, `IP-Profil „${profile.name}“ anwenden – Adapter "${adapter.name}"`, cmds, false);
    if (ok) setAdapter(adapter, profile);
    const revert = async (why: string) => {
      events.ipProfile.emit({ phase: "reverting", seconds: null, message: why, ok: true });
      const back = steps(adapter.name, currentOf(adapter), from);
      if (back.length) await runSteps(restoreId++, `Vorherige IP-Konfiguration wiederherstellen – Adapter "${adapter.name}"`, back, true);
      setAdapter(adapter, from);
      return `Vorherige Konfiguration wiederhergestellt: ${describeCurrent(from)}`;
    };
    if (!ok) {
      const msg = await revert("Anwenden fehlgeschlagen – vorherige Konfiguration wird wiederhergestellt …");
      events.ipProfile.emit({ phase: "reverted", seconds: null, message: `Anwenden fehlgeschlagen – ${msg}`, ok: false });
      busy = false;
      return;
    }
    events.ipProfile.emit({ phase: "pending", seconds: 30, message: describeProfile(profile), ok: true });
    const keep = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 30_000);
      decide = (k) => {
        clearTimeout(timer);
        resolve(k);
      };
    });
    decide = null;
    if (keep) {
      events.ipProfile.emit({ phase: "kept", seconds: null, message: `IP-Profil „${profile.name}“ behalten: ${describeProfile(profile)}`, ok: true });
    } else {
      const msg = await revert("Keine Bestätigung – vorherige Konfiguration wird wiederhergestellt …");
      events.ipProfile.emit({ phase: "reverted", seconds: null, message: msg, ok: true });
    }
    busy = false;
  })();
}

export async function ipProfileKeep(): Promise<void> {
  if (!decide) throw "Es wartet keine IP-Änderung auf Bestätigung.";
  decide(true);
}

export async function ipProfileRevert(): Promise<void> {
  if (!decide) throw "Es wartet keine IP-Änderung auf Bestätigung.";
  decide(false);
}

// ---- Kompaktmodus, Autostart -----------------------------------------------------

let compact = false;

export async function setCompact(enabled: boolean): Promise<boolean> {
  compact = enabled;
  events.compact.emit(compact);
  return compact;
}

export async function getCompact(): Promise<boolean> {
  return compact;
}

let autostart = false;

export async function autostartGet(): Promise<AutostartStatus> {
  return { supported: true, enabled: autostart, otherPath: false };
}

export async function autostartSet(enabled: boolean): Promise<AutostartStatus> {
  await delay(60);
  autostart = enabled;
  return autostartGet();
}

// ---- Update-Check ----------------------------------------------------------------

export async function openReleasePage(url: string): Promise<void> {
  if (!isReleaseUrl(url)) throw "Diese Adresse wird aus Sicherheitsgründen nicht geöffnet.";
  console.info("[Mock] würde im Browser öffnen:", url);
}

/** Antwort der GitHub-API simulieren (?update=new|private|offline|ratelimit, sonst aktuell) */
export async function latestRelease(): Promise<ReleaseCheck> {
  await delay(300);
  switch (params.get("update")) {
    case "new":
      return interpretRelease(200, { tag_name: "v9.9.0", html_url: `${RELEASES_URL}/tag/v9.9.0` });
    case "private":
      return interpretRelease(404, { message: "Not Found" });
    case "ratelimit":
      return interpretRelease(403, { message: "API rate limit exceeded" });
    case "offline":
      return { kind: "error", reason: "offline" };
    default:
      return interpretRelease(200, { tag_name: `v${__APP_VERSION__}`, html_url: `${RELEASES_URL}/tag/v${__APP_VERSION__}` });
  }
}
