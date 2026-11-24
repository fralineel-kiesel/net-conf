// Mock-Backend für Phase 4b: WLAN (F7), Live-Traffic und Verbindungen (F8).
//
// URL-Parameter zum Testen der Randfälle:
//   ?wifi=none      kein WLAN-Adapter / Dienst aus
//   ?wifi=multi     zwei WLAN-Adapter (Auswahl erscheint)
//   ?wifi=location  Standortdienste aus (SSIDs fehlen, Hinweis)
//   ?conns=many     1200 Verbindungen (Grenze 500 Zeilen testen)
//
// Verbinden im Mock:
//   Passwort mit "falsch"  → falsches Passwort
//   Netz "Hotspot-Handy"   → Zeitüberschreitung
//   verstecktes Netz mit unbekannter SSID → nicht erreichbar
// Das Passwort wird auch hier nirgends ausgegeben oder gespeichert.
import { NAMES_HIDDEN_HINT, passwordProblem, ssidProblem } from "./wifiutil";
import type {
  Connection,
  IfTraffic,
  TrafficSample,
  WifiBss,
  WifiConnectRequest,
  WifiInfo,
  WifiNetwork,
  WifiProfile,
  WifiScanResult,
  WifiSecurity,
} from "./types";

const params = new URLSearchParams(location.search);
const wifiMode = params.get("wifi");
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const LOCATION_HINT =
  "Windows gibt die WLAN-Details nur mit Standortzugriff frei: Einstellungen → Datenschutz und Sicherheit → Standort → „Desktop-Apps den Zugriff auf Ihren Standort erlauben“ einschalten.";

const IF_MAIN = "{A1B2C3D4-0001}";
const IF_USB = "{A1B2C3D4-0005}";

// ---- Zustand (ändert sich durch Verbinden/Trennen/Vergessen) ---------------

interface MockNet {
  ssid: string;
  security: string;
  connectAs: WifiSecurity | null;
  /** Access Points: [Signal %, Frequenz MHz] */
  aps: [number, number][];
}

const NETS: MockNet[] = [
  { ssid: "FRITZ!Box 7590 XY", security: "WPA2", connectAs: "wpa2", aps: [[78, 5180], [62, 2437], [41, 5500]] },
  { ssid: "UPC1234567", security: "WPA2", connectAs: "wpa2", aps: [[54, 2412]] },
  { ssid: "Sunrise_5GHz_8A2F", security: "WPA3", connectAs: "wpa3", aps: [[48, 5220]] },
  { ssid: "Swisscom-Gast", security: "OFFEN", connectAs: "open", aps: [[40, 2462]] },
  { ssid: "FirmaXY", security: "802.1X", connectAs: null, aps: [[35, 2437], [28, 5500]] },
  { ssid: "", security: "WPA2", connectAs: "wpa2", aps: [[30, 2462]] },
  { ssid: "Nachbar & Co <3", security: "WPA2", connectAs: "wpa2", aps: [[22, 2437]] },
  { ssid: "Hotspot-Handy", security: "WPA3", connectAs: "wpa3", aps: [[18, 5745]] },
  { ssid: "DIRECT-7B-HP M281 LaserJet", security: "WPA2", connectAs: "wpa2", aps: [[15, 2437]] },
  { ssid: "Wi-Fi7-Testlab", security: "WPA3", connectAs: "wpa3", aps: [[12, 6115]] },
];

let connectedSsid: string | null = wifiMode === "none" ? null : "FRITZ!Box 7590 XY";
let profiles: WifiProfile[] = [
  { name: "FRITZ!Box 7590 XY", groupPolicy: false, perUser: false },
  { name: "Zuhause-Eltern", groupPolicy: false, perUser: false },
  { name: "Cafe Bahnhof", groupPolicy: false, perUser: true },
  { name: "Schule-WLAN", groupPolicy: true, perUser: false },
];

const channelOf = (mhz: number) =>
  mhz === 2484 ? 14 : mhz < 3000 ? (mhz - 2407) / 5 : mhz < 5900 ? (mhz - 5000) / 5 : (mhz - 5950) / 5;
const bandOf = (mhz: number) => (mhz < 3000 ? "2,4 GHz" : mhz < 5900 ? "5 GHz" : "6 GHz");
const jitter = (v: number, by: number) => Math.max(1, Math.min(100, Math.round(v + (Math.random() * 2 - 1) * by)));

function checkInterface(id: string): void {
  if (wifiMode === "none") throw "Kein WLAN verfügbar: Es gibt keinen WLAN-Adapter oder der Dienst „WLAN-AutoKonfiguration“ läuft nicht.";
  if (id !== IF_MAIN && !(wifiMode === "multi" && id === IF_USB)) {
    throw "Der WLAN-Adapter wurde nicht gefunden (entfernt oder deaktiviert?). Bitte neu laden.";
  }
}

// ---- WLAN-Status (auch für die Übersicht) -----------------------------------

export async function getWifi(): Promise<WifiInfo[]> {
  if (wifiMode === "none") return [];
  const list: WifiInfo[] = [];
  const net = NETS.find((n) => n.ssid === connectedSsid);
  const [sig, mhz] = net?.aps[0] ?? [0, 0];
  const base: WifiInfo = {
    interfaceId: IF_MAIN,
    description: "Intel(R) Wi-Fi 6 AX201 160MHz",
    connected: !!net,
    state: net ? "verbunden" : "getrennt",
    ssid: "",
    bssid: "",
    profile: "",
    signalQuality: null,
    rssiDbm: null,
    channel: null,
    frequencyMhz: null,
    band: null,
    phy: "",
    rxMbps: null,
    txMbps: null,
    auth: "",
    cipher: "",
    error: null,
  };
  if (net && wifiMode === "location") {
    list.push({ ...base, error: LOCATION_HINT });
  } else if (net) {
    const q = jitter(sig, 6);
    list.push({
      ...base,
      ssid: net.ssid,
      bssid: "3C-A6-2F-11-22-34",
      profile: net.ssid,
      signalQuality: q,
      rssiDbm: Math.round(q / 2 - 97),
      channel: channelOf(mhz),
      frequencyMhz: mhz,
      band: bandOf(mhz),
      phy: mhz > 5900 ? "802.11be (Wi-Fi 7)" : "802.11ax (Wi-Fi 6/6E)",
      rxMbps: q > 70 ? 866.7 : 573.5,
      txMbps: q > 70 ? 721.6 : 432.3,
      auth: net.security === "WPA3" ? "WPA3-Personal" : net.security === "OFFEN" ? "Offen" : "WPA2-Personal",
      cipher: net.security === "OFFEN" ? "keine" : "AES (CCMP)",
    });
  } else {
    list.push(base);
  }
  if (wifiMode === "multi") {
    list.push({
      ...base,
      interfaceId: IF_USB,
      description: "NETGEAR A6210 WiFi USB3.0 Adapter",
      connected: false,
      state: "getrennt",
    });
  }
  return list;
}

// ---- Netze, Scan, Profile ---------------------------------------------------

export async function wifiNetworks(interfaceId: string): Promise<WifiScanResult> {
  await delay(150);
  checkInterface(interfaceId);
  if (wifiMode === "location") return { networks: [], bss: [], hint: NAMES_HIDDEN_HINT };
  if (interfaceId === IF_USB) return { networks: [], bss: [], hint: NAMES_HIDDEN_HINT };
  const bss: WifiBss[] = [];
  const networks: WifiNetwork[] = NETS.map((n, i) => {
    const aps = n.aps.map(([sig, mhz], k) => {
      const b: WifiBss = {
        ssid: n.ssid,
        bssid: `3C-A6-2F-${String(10 + i).padStart(2, "0")}-${String(20 + k).padStart(2, "0")}-34`,
        signal: jitter(sig, 3),
        rssiDbm: Math.round(sig / 2 - 97),
        frequencyMhz: mhz,
        channel: channelOf(mhz),
        band: bandOf(mhz),
      };
      bss.push(b);
      return b;
    });
    const best = aps.reduce((a, b) => (b.signal > a.signal ? b : a));
    const profile = profiles.find((p) => p.name === n.ssid)?.name ?? "";
    return {
      ssid: n.ssid,
      hidden: n.ssid === "",
      signal: best.signal,
      rssiDbm: best.rssiDbm,
      channel: best.channel,
      band: best.band,
      apCount: aps.length,
      security: n.security,
      connectAs: n.connectAs,
      connected: n.ssid === connectedSsid,
      saved: profile !== "",
      profile,
    };
  });
  networks.sort((a, b) => Number(b.connected) - Number(a.connected) || b.signal - a.signal);
  return { networks, bss, hint: null };
}

export async function wifiScan(interfaceId: string): Promise<void> {
  await delay(100);
  checkInterface(interfaceId);
}

export async function wifiProfiles(interfaceId: string): Promise<WifiProfile[]> {
  await delay(80);
  checkInterface(interfaceId);
  return interfaceId === IF_USB ? [] : structuredClone(profiles);
}

export async function wifiConnectProfile(interfaceId: string, profile: string): Promise<string> {
  checkInterface(interfaceId);
  if (!profiles.some((p) => p.name === profile)) throw "Dieses Profil gibt es nicht (mehr). Bitte die Liste neu laden.";
  await delay(1800);
  if (!NETS.some((n) => n.ssid === profile)) {
    throw "Das Netz ist nicht erreichbar (ausser Reichweite oder ausgeschaltet). Bitte neu scannen.";
  }
  connectedSsid = profile;
  return `Verbunden mit „${profile}“.`;
}

export async function wifiConnect(req: WifiConnectRequest): Promise<string> {
  // Gleiche Prüfungen wie im Backend (Meldungen ohne Passwort!)
  checkInterface(req.interfaceId);
  const ssidErr = ssidProblem(req.ssid);
  if (ssidErr) throw ssidErr;
  const visible = req.hidden ? undefined : NETS.find((n) => n.ssid === req.ssid);
  let security = req.security;
  if (visible) {
    if (!visible.connectAs) throw "[802.1X] nicht unterstützt, bitte über Windows verbinden.";
    security = visible.connectAs;
  }
  const pwErr = passwordProblem(security, req.password);
  if (pwErr) throw pwErr;
  if (profiles.some((p) => p.name === req.ssid && p.groupPolicy)) {
    throw "Für dieses Netz gibt es ein Profil aus einer Gruppenrichtlinie (Firma). Bitte über Windows verbinden.";
  }
  const wrong = req.password.toLowerCase().includes("falsch");
  await delay(2500);
  if (req.ssid === "Hotspot-Handy") {
    throw "Zeitüberschreitung: Der Access Point hat nicht rechtzeitig geantwortet. Näher an den Router gehen und erneut versuchen.";
  }
  if (!visible && !NETS.some((n) => n.ssid === req.ssid)) {
    throw "Das Netz ist nicht erreichbar (ausser Reichweite oder ausgeschaltet). Bitte neu scannen.";
  }
  if (wrong) throw "Das Passwort ist vermutlich falsch. Bitte prüfen (Gross-/Kleinschreibung!) und erneut versuchen.";
  connectedSsid = req.ssid;
  if (!profiles.some((p) => p.name === req.ssid)) profiles.unshift({ name: req.ssid, groupPolicy: false, perUser: false });
  return `Verbunden mit „${req.ssid}“. Das Profil ist in Windows gespeichert.`;
}

export async function wifiDisconnect(interfaceId: string): Promise<void> {
  checkInterface(interfaceId);
  await delay(300);
  connectedSsid = null;
}

export async function wifiForget(interfaceId: string, profile: string): Promise<void> {
  checkInterface(interfaceId);
  const p = profiles.find((x) => x.name === profile);
  if (!p) throw "Dieses Profil gibt es nicht (mehr). Bitte die Liste neu laden.";
  if (p.groupPolicy) throw "Profile aus einer Gruppenrichtlinie (Firma) lassen sich nicht löschen.";
  await delay(150);
  profiles = profiles.filter((x) => x.name !== profile);
}

// ---- Live-Traffic -----------------------------------------------------------

interface MockIf {
  id: string;
  name: string;
  description: string;
  connected: boolean;
  isVirtual: boolean;
  link: number;
  rx: number;
  tx: number;
}
const IFS: MockIf[] = [
  { id: IF_MAIN, name: "WLAN", description: "Intel(R) Wi-Fi 6 AX201 160MHz", connected: true, isVirtual: false, link: 866_700_000, rx: 4.2e9, tx: 6.1e8 },
  { id: "{A1B2C3D4-0002}", name: "vEthernet (WSL)", description: "Hyper-V Virtual Ethernet Adapter", connected: true, isVirtual: true, link: 10e9, rx: 2.1e7, tx: 1.9e7 },
  { id: "{A1B2C3D4-0003}", name: "Ethernet", description: "Realtek PCIe GbE Family Controller", connected: false, isVirtual: false, link: 0, rx: 0, tx: 0 },
];
let lastPoll: number | null = null;
let tick = 0;

export async function trafficPoll(): Promise<TrafficSample> {
  const now = performance.now();
  const elapsed = lastPoll === null || now - lastPoll > 5000 ? null : now - lastPoll;
  lastPoll = now;
  tick++;
  const interfaces: IfTraffic[] = IFS.map((f) => {
    let rxBps = 0;
    let txBps = 0;
    if (f.connected && elapsed !== null) {
      if (f.isVirtual) {
        rxBps = Math.random() < 0.2 ? Math.random() * 3e6 : 0;
        txBps = rxBps * 0.4;
      } else {
        // Grundrauschen + Wellen + ab und zu ein Download-Schub
        const burst = tick % 40 > 25 ? 60e6 + Math.random() * 25e6 : 0;
        rxBps = 0.4e6 + Math.abs(Math.sin(tick / 6)) * 6e6 + Math.random() * 1.5e6 + burst;
        txBps = 0.15e6 + Math.abs(Math.cos(tick / 9)) * 1.2e6 + Math.random() * 0.4e6 + burst * 0.05;
      }
    }
    const secs = (elapsed ?? 0) / 1000;
    const rxDelta = elapsed === null ? null : Math.round((rxBps / 8) * secs);
    const txDelta = elapsed === null ? null : Math.round((txBps / 8) * secs);
    f.rx += rxDelta ?? 0;
    f.tx += txDelta ?? 0;
    return {
      id: f.id,
      name: f.name,
      description: f.description,
      connected: f.connected,
      isVirtual: f.isVirtual,
      rxDelta,
      txDelta,
      rxBps: elapsed === null ? null : rxBps,
      txBps: elapsed === null ? null : txBps,
      rxLinkBps: f.connected ? f.link : null,
      txLinkBps: f.connected ? f.link : null,
    };
  });
  return { elapsedMs: elapsed === null ? null : Math.round(elapsed), interfaces };
}

export async function trafficReset(): Promise<void> {
  lastPoll = null;
}

// ---- Verbindungen -----------------------------------------------------------

const REMOTES: [string, number, string][] = [
  ["140.82.121.4", 443, "chrome.exe"],
  ["142.250.185.78", 443, "chrome.exe"],
  ["142.250.185.110", 443, "chrome.exe"],
  ["13.107.42.14", 443, "OneDrive.exe"],
  ["52.113.194.132", 443, "ms-teams.exe"],
  ["35.186.224.25", 4070, "Spotify.exe"],
  ["20.42.65.92", 443, "svchost.exe"],
  ["192.168.1.1", 53, "svchost.exe"],
  ["192.168.1.20", 445, "System"],
  ["151.101.1.69", 443, "msedge.exe"],
];
const LISTEN: [number, number, string, string][] = [
  [135, 1100, "svchost.exe", "0.0.0.0"],
  [445, 4, "System", "0.0.0.0"],
  [5040, 6212, "svchost.exe", "0.0.0.0"],
  [7680, 9012, "svchost.exe", "0.0.0.0"],
  [49664, 812, "(kein Zugriff)", "0.0.0.0"],
  [49665, 1004, "(kein Zugriff)", "0.0.0.0"],
  [139, 4, "System", "192.168.1.42"],
  [5432, 3320, "postgres.exe", "127.0.0.1"],
];

export async function getConnections(): Promise<Connection[]> {
  await delay(120);
  const out: Connection[] = [];
  const pidOf: Record<string, number> = {
    "chrome.exe": 10424, "OneDrive.exe": 8812, "ms-teams.exe": 15220, "Spotify.exe": 11008,
    "svchost.exe": 2412, "System": 4, "msedge.exe": 7720,
  };
  for (const [port, pid, process, addr] of LISTEN) {
    out.push({ proto: "TCP", family: 4, localAddr: addr, localPort: port, remoteAddr: "0.0.0.0", remotePort: 0, state: "LISTEN", pid, process });
  }
  out.push({ proto: "TCP", family: 6, localAddr: "::", localPort: 135, remoteAddr: "::", remotePort: 0, state: "LISTEN", pid: 1100, process: "svchost.exe" });
  out.push({ proto: "TCP", family: 6, localAddr: "::", localPort: 445, remoteAddr: "::", remotePort: 0, state: "LISTEN", pid: 4, process: "System" });
  const many = params.get("conns") === "many";
  const count = many ? 1100 : 34;
  for (let i = 0; i < count; i++) {
    const [ip, port, process] = REMOTES[i % REMOTES.length];
    const state = i % 9 === 8 ? "TIME_WAIT" : i % 13 === 12 ? "CLOSE_WAIT" : "ESTABLISHED";
    out.push({
      proto: "TCP",
      family: 4,
      localAddr: "192.168.1.42",
      localPort: 50100 + i * 7,
      remoteAddr: ip,
      remotePort: port,
      state,
      pid: state === "TIME_WAIT" ? 0 : pidOf[process] ?? 1,
      process: state === "TIME_WAIT" ? "System" : process,
    });
  }
  out.push({
    proto: "TCP", family: 6, localAddr: "2a02:1210:5e0c:a100:1c2d:3e4f:5a6b:7c8d", localPort: 51544,
    remoteAddr: "2a00:1450:4001:82b::200e", remotePort: 443, state: "ESTABLISHED", pid: 10424, process: "chrome.exe",
  });
  out.push({ proto: "TCP", family: 6, localAddr: "::1", localPort: 49711, remoteAddr: "::1", remotePort: 5432, state: "ESTABLISHED", pid: 3320, process: "postgres.exe" });
  for (const [port, pid, process] of [[53, 2412, "svchost.exe"], [5353, 7720, "msedge.exe"], [5355, 2412, "svchost.exe"], [1900, 6100, "svchost.exe"], [123, 1844, "svchost.exe"], [137, 4, "System"], [55021, 11008, "Spotify.exe"]] as [number, number, string][]) {
    out.push({ proto: "UDP", family: 4, localAddr: port === 137 ? "192.168.1.42" : "0.0.0.0", localPort: port, remoteAddr: "", remotePort: 0, state: "", pid, process });
  }
  out.push({ proto: "UDP", family: 6, localAddr: "fe80::1c2d:3e4f:5a6b:7c8d%12", localPort: 1900, remoteAddr: "", remotePort: 0, state: "", pid: 6100, process: "svchost.exe" });
  out.push({ proto: "UDP", family: 6, localAddr: "::", localPort: 5353, remoteAddr: "", remotePort: 0, state: "", pid: 7720, process: "msedge.exe" });
  return out;
}

const PTR: Record<string, string> = {
  "140.82.121.4": "lb-140-82-121-4-fra.github.com",
  "142.250.185.78": "fra16s52-in-f14.1e100.net",
  "142.250.185.110": "fra16s53-in-f14.1e100.net",
  "192.168.1.1": "fritz.box",
  "192.168.1.20": "nas-keller.fritz.box",
  "151.101.1.69": "151.101.1.69", // manche Server antworten mit der IP selbst
  "2a00:1450:4001:82b::200e": "fra24s06-in-x0e.1e100.net",
};

export async function reverseDns(address: string): Promise<string | null> {
  await delay(250 + Math.random() * 300);
  const a = address.trim();
  if (!/^[0-9a-fA-F.:%]+$/.test(a)) throw "Ungültige IP-Adresse.";
  if (a === "0.0.0.0" || a === "::") throw "Für diese Adresse gibt es keinen Namen.";
  return PTR[a] ?? null;
}
