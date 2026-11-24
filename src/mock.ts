// Mock-Backend für die Entwicklung im Browser (`npm run dev`).
// Simuliert Adapterdaten und die (deutsche) Ausgabe von ipconfig/ping.
//
// Tipp: Mit `?admin=1` in der URL tut der Mock so, als liefe die App
// mit Administratorrechten.
import { events } from "./events";
import { validateTarget } from "./validate";
import type {
  AdapterInfo,
  DnsRequest,
  DnsResponse,
  NeighborEntry,
  NetCommand,
  PortTestRequest,
  PortTestResponse,
  PublicIp,
  RouteEntry,
  WifiInfo,
} from "./types";

const now = Math.floor(Date.now() / 1000);
let admin = new URLSearchParams(location.search).get("admin") === "1";

const ADAPTERS: AdapterInfo[] = [
  {
    id: "{A1B2C3D4-0001}",
    name: "WLAN",
    description: "Intel(R) Wi-Fi 6 AX201 160MHz",
    connected: true,
    mac: "A4-C3-F0-12-34-56",
    ipv4: [{ address: "192.168.1.42", subnetMask: "255.255.255.0" }],
    ipv6: ["2a02:1210:5e0c:a100:1c2d:3e4f:5a6b:7c8d", "fe80::1c2d:3e4f:5a6b:7c8d"],
    gateways: ["192.168.1.1"],
    dnsServers: ["192.168.1.1", "1.1.1.1"],
    dhcpEnabled: true,
    dhcpServer: "192.168.1.1",
    leaseObtained: now - 3 * 3600,
    leaseExpires: now + 21 * 3600,
    dnsSuffix: "fritz.box",
  },
  {
    id: "{A1B2C3D4-0002}",
    name: "vEthernet (WSL)",
    description: "Hyper-V Virtual Ethernet Adapter",
    connected: true,
    mac: "00-15-5D-AB-CD-EF",
    ipv4: [{ address: "172.27.80.1", subnetMask: "255.255.240.0" }],
    ipv6: ["fe80::8d3a:2b1c:4e5f:6a7b"],
    gateways: [],
    dnsServers: [],
    dhcpEnabled: false,
    dhcpServer: null,
    leaseObtained: null,
    leaseExpires: null,
    dnsSuffix: "",
  },
  {
    id: "{A1B2C3D4-0003}",
    name: "Ethernet",
    description: "Realtek PCIe GbE Family Controller",
    connected: false,
    mac: "D8-BB-C1-98-76-54",
    ipv4: [],
    ipv6: [],
    gateways: [],
    dnsServers: [],
    dhcpEnabled: true,
    dhcpServer: null,
    leaseObtained: null,
    leaseExpires: null,
    dnsSuffix: "",
  },
  {
    id: "{A1B2C3D4-0004}",
    name: "Bluetooth-Netzwerkverbindung",
    description: "Bluetooth Device (Personal Area Network)",
    connected: false,
    mac: "A4-C3-F0-12-34-5A",
    ipv4: [],
    ipv6: [],
    gateways: [],
    dnsServers: [],
    dhcpEnabled: true,
    dhcpServer: null,
    leaseObtained: null,
    leaseExpires: null,
    dnsSuffix: "",
  },
];

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function getAdapters(): Promise<AdapterInfo[]> {
  await delay(120);
  return structuredClone(ADAPTERS);
}

export async function getHostname(): Promise<string> {
  return "DESKTOP-MOCK42";
}

export async function isAdmin(): Promise<boolean> {
  return admin;
}

export async function restartAsAdmin(): Promise<void> {
  // Im Browser: Seite mit ?admin=1 neu laden.
  admin = true;
  const url = new URL(location.href);
  url.searchParams.set("admin", "1");
  location.href = url.toString();
}

// Laufende simulierte Befehle (für Abbruch).
const running = new Map<number, { cancelled: boolean }>();

export async function cancelCommand(runId: number): Promise<void> {
  const r = running.get(runId);
  if (r) r.cancelled = true;
}

export async function runCommand(runId: number, command: NetCommand): Promise<void> {
  // Gleiche Prüfung wie im Backend, damit der Mock sich gleich verhält.
  if (command.kind === "ping" || command.kind === "tracert") {
    const err = validateTarget(command.target);
    if (err) throw err;
  }
  const state = { cancelled: false };
  running.set(runId, state);
  events.started.emit({ runId, commandLine: commandLine(command) });

  // Asynchron weiterlaufen lassen, wie das echte Backend.
  void simulate(runId, command, state).then((exitCode) => {
    running.delete(runId);
    events.finished.emit({ runId, exitCode: state.cancelled ? null : exitCode, cancelled: state.cancelled });
  });
}

function commandLine(c: NetCommand): string {
  switch (c.kind) {
    case "release":
    case "renew":
      return `ipconfig /${c.kind}${c.adapter ? ` "${c.adapter}"` : ""}`;
    case "flushDns":
      return "ipconfig /flushdns";
    case "registerDns":
      return "ipconfig /registerdns";
    case "ping":
      return `ping ${c.count === null ? "-t" : `-n ${c.count}`} ${c.target.trim()}`;
    case "tracert":
      return `tracert -h 30 -w 1000 ${c.resolve ? "" : "-d "}${c.target.trim()}`;
  }
}

async function simulate(runId: number, c: NetCommand, st: { cancelled: boolean }): Promise<number> {
  const out = (line: string, stream: "stdout" | "stderr" = "stdout") =>
    events.output.emit({ runId, stream, line });

  const needsAdmin = c.kind === "release" || c.kind === "renew" || c.kind === "registerDns";
  if (needsAdmin && !admin) {
    await delay(150);
    out("");
    out("Windows-IP-Konfiguration");
    out("");
    out("Der angeforderte Vorgang erfordert erhöhte Rechte.");
    return 1;
  }

  switch (c.kind) {
    case "flushDns":
      await delay(200);
      out("");
      out("Windows-IP-Konfiguration");
      out("");
      out("Der DNS-Auflösungscache wurde geleert.");
      return 0;
    case "registerDns":
      await delay(300);
      out("");
      out("Windows-IP-Konfiguration");
      out("");
      out("Die Registrierung der DNS-Ressourceneinträge für alle Adapter dieses Computers wurde initiiert.");
      out("Eventuelle Fehler werden innerhalb von 15 Minuten in der Ereignisanzeige angezeigt.");
      return 0;
    case "release":
    case "renew":
      await delay(c.kind === "renew" ? 1500 : 600);
      out("");
      out("Windows-IP-Konfiguration");
      out("");
      for (const a of ADAPTERS.filter((x) => !c.adapter || x.name === c.adapter)) {
        out(`Drahtlos-LAN-Adapter ${a.name}:`);
        out("");
        out(`   Verbindungsspezifisches DNS-Suffix: ${a.dnsSuffix}`);
        out(`   IPv4-Adresse  . . . . . . . . . . : ${c.kind === "renew" ? a.ipv4[0]?.address ?? "" : ""}`);
        out("");
      }
      return 0;
    case "ping":
      return simulatePing(c.target.trim(), c.count, st, out);
    case "tracert":
      return simulateTracert(c.target.trim(), c.resolve, st, out);
  }
}

async function simulateTracert(
  target: string,
  resolve: boolean,
  st: { cancelled: boolean },
  out: (l: string) => void,
): Promise<number> {
  await delay(150);
  if (target.endsWith(".invalid")) {
    out(`Der Zielname ${target} konnte nicht aufgelöst werden.`);
    return 1;
  }
  const ip = /^[\d.]+$/.test(target) ? target : "142.250.185.78";
  out("");
  out(`Routenverfolgung zu ${ip === target ? ip : `${target} [${ip}]`} über maximal 30 Hops`);
  out("");
  const hops: [string, string | null, number][] = [
    ["192.168.1.1", "fritz.box", 1],
    ["100.64.0.1", null, 8],
    ["", null, 0], // antwortet nicht
    ["62.2.17.33", "ip-62-2-17-33.static.init7.net", 11],
    ["72.14.196.21", null, 13],
    [ip, ip === target ? null : target, 14],
  ];
  const fmt = (ms: number) => (ms < 1 ? "<1 ms" : `${ms} ms`).padStart(6);
  for (let i = 0; i < hops.length; i++) {
    for (let w = 0; w < (hops[i][0] ? 4 : 12) && !st.cancelled; w++) await delay(100);
    if (st.cancelled) return 0;
    const [addr, name, base] = hops[i];
    const n = String(i + 1).padStart(3);
    if (!addr) {
      out(`${n}     *        *        *     Zeitüberschreitung der Anforderung.`);
      continue;
    }
    const t = () => fmt(Math.max(0, base + Math.round(Math.random() * 4 - 1)));
    const host = resolve && name ? `${name} [${addr}]` : addr;
    out(`${n}  ${t()}  ${t()}  ${t()}  ${host}`);
  }
  out("");
  out("Ablaufverfolgung beendet.");
  return 0;
}

async function simulatePing(
  target: string,
  count: number | null,
  st: { cancelled: boolean },
  out: (l: string) => void,
): Promise<number> {
  await delay(80);
  if (target.endsWith(".invalid")) {
    out(`Ping-Anforderung konnte Host "${target}" nicht finden. Überprüfen Sie den Namen, und versuchen Sie es erneut.`);
    return 1;
  }
  const ip = /^[\d.]+$/.test(target) ? target : "142.250.185.78";
  out("");
  out(
    ip === target
      ? `Ping wird ausgeführt für ${ip} mit 32 Bytes Daten:`
      : `Ping wird ausgeführt für ${target} [${ip}] mit 32 Bytes Daten:`,
  );
  const times: number[] = [];
  let sent = 0;
  for (let i = 0; count === null || i < count; i++) {
    // In 100-ms-Schritten warten, damit "Stop" sofort greift.
    for (let w = 0; i > 0 && w < 10 && !st.cancelled; w++) await delay(100);
    if (st.cancelled) return 0;
    sent++;
    if (Math.random() < 0.06) {
      out("Zeitüberschreitung der Anforderung.");
      continue;
    }
    const t = Math.max(0, Math.round(12 + Math.random() * 10 + (Math.random() < 0.1 ? 40 : 0)));
    times.push(t);
    out(`Antwort von ${ip}: Bytes=32 Zeit${t < 1 ? "<1" : "=" + t}ms TTL=57`);
  }
  const recv = times.length;
  out("");
  out(`Ping-Statistik für ${ip}:`);
  out(`    Pakete: Gesendet = ${sent}, Empfangen = ${recv}, Verloren = ${sent - recv}`);
  out(`    (${Math.round(((sent - recv) / sent) * 100)}% Verlust),`);
  if (recv > 0) {
    const avg = Math.round(times.reduce((a, b) => a + b, 0) / recv);
    out("Ca. Zeitangaben in Millisek.:");
    out(`    Minimum = ${Math.min(...times)}ms, Maximum = ${Math.max(...times)}ms, Mittelwert = ${avg}ms`);
  }
  return recv > 0 ? 0 : 1;
}

// ---- Phase 2 ---------------------------------------------------------------

export async function dnsQuery(req: DnsRequest): Promise<DnsResponse> {
  await delay(180);
  const name = req.name.trim().toLowerCase().replace(/\.$/, "");
  if (!name) throw "Bitte einen Namen eingeben (z. B. example.com).";
  if (!/^[a-z0-9._:-]+$/.test(name)) throw "Ungültiger Name. Erlaubt sind Buchstaben (a–z), Ziffern, '-', '_' und Punkte.";
  const server = req.server?.trim() || "192.168.1.1";
  const base = { server, queryName: name, recordType: req.recordType, authoritative: false, truncated: false, elapsedMs: 9 + Math.round(Math.random() * 20), authority: [] };
  if (name.endsWith(".invalid")) {
    return { ...base, rcode: 3, rcodeText: "Domain existiert nicht (NXDOMAIN)", answers: [], authority: [{ name: "invalid", recordType: "SOA", ttl: 900, data: "a.root-servers.net nstld.verisign-grs.com (Serial 2026112400, Minimum-TTL 86400s)" }] };
  }
  const rec = (data: string, recordType = req.recordType, ttl = 300) => ({ name, recordType, ttl, data });
  const answers: Record<string, ReturnType<typeof rec>[]> = {
    A: [rec("142.250.185.78"), rec("142.250.185.110")],
    AAAA: [rec("2a00:1450:4001:82b::200e")],
    CNAME: [rec(`www.${name}.cdn.example.net`)],
    MX: [rec(`10 smtp.${name}`, "MX", 3600), rec(`20 smtp2.${name}`, "MX", 3600)],
    NS: [rec(`ns1.${name}`, "NS", 86400), rec(`ns2.${name}`, "NS", 86400)],
    TXT: [rec('"v=spf1 include:_spf.example.net ~all"'), rec('"google-site-verification=abc123"')],
    PTR: [rec("one.one.one.one", "PTR", 1800)],
    SOA: [rec(`ns1.${name} hostmaster.${name} (Serial 2026112401, Minimum-TTL 300s)`, "SOA", 3600)],
  };
  return { ...base, rcode: 0, rcodeText: "OK", answers: answers[req.recordType] ?? [] };
}

export async function portTest(req: PortTestRequest): Promise<PortTestResponse> {
  const host = req.host.trim();
  const err = validateTarget(host);
  if (err) throw err;
  if (req.ports.length === 0) throw "Bitte mindestens einen Port angeben.";
  const timeout = req.timeoutMs ?? 2000;
  const results = [...new Set(req.ports)].sort((a, b) => a - b).map((port) => {
    if ([80, 443, 53].includes(port)) return { port, status: "open" as const, ms: 8 + Math.round(Math.random() * 15), message: null };
    if ([22, 3389].includes(port)) return { port, status: "closed" as const, ms: 9, message: null };
    return { port, status: "filtered" as const, ms: null, message: null };
  });
  // Gefilterte Ports warten bis zum Timeout – wie in echt
  await delay(results.some((r) => r.status === "filtered") ? Math.min(timeout, 1500) : 200);
  return { host, address: /^[\d.]+$/.test(host) ? host : "142.250.185.78", results };
}

export async function getArpTable(): Promise<NeighborEntry[]> {
  await delay(120);
  const e = (address: string, mac: string, state: string, iface = "WLAN", family: 4 | 6 = 4) => ({
    address, family, mac, interface: iface, state, permanent: state === "statisch",
  });
  return [
    e("192.168.1.1", "3C-A6-2F-11-22-33", "erreichbar"),
    e("192.168.1.20", "B8-27-EB-44-55-66", "veraltet"),
    e("192.168.1.35", "", "unerreichbar"),
    e("192.168.1.255", "FF-FF-FF-FF-FF-FF", "statisch"),
    e("224.0.0.22", "01-00-5E-00-00-16", "statisch"),
    e("224.0.0.251", "01-00-5E-00-00-FB", "statisch"),
    e("239.255.255.250", "01-00-5E-7F-FF-FA", "statisch"),
    e("255.255.255.255", "FF-FF-FF-FF-FF-FF", "statisch"),
    e("fe80::3ea6:2fff:fe11:2233", "3C-A6-2F-11-22-33", "erreichbar", "WLAN", 6),
    e("ff02::1:2", "33-33-00-01-00-02", "statisch", "WLAN", 6),
    e("172.27.80.255", "FF-FF-FF-FF-FF-FF", "statisch", "vEthernet (WSL)"),
  ];
}

export async function getRouteTable(): Promise<RouteEntry[]> {
  await delay(120);
  const r = (destination: string, gateway: string, iface: string, metric: number, family: 4 | 6 = 4) => ({
    destination, prefixLen: Number(destination.split("/")[1]), gateway, interface: iface, metric, family,
  });
  return [
    r("0.0.0.0/0", "192.168.1.1", "WLAN", 35),
    r("127.0.0.0/8", "", "Loopback Pseudo-Interface 1", 331),
    r("127.0.0.1/32", "", "Loopback Pseudo-Interface 1", 331),
    r("172.27.80.0/20", "", "vEthernet (WSL)", 5256),
    r("192.168.1.0/24", "", "WLAN", 291),
    r("192.168.1.42/32", "", "WLAN", 291),
    r("192.168.1.255/32", "", "WLAN", 291),
    r("224.0.0.0/4", "", "WLAN", 291),
    r("255.255.255.255/32", "", "WLAN", 291),
    r("::/0", "fe80::3ea6:2fff:fe11:2233", "WLAN", 291, 6),
    r("::1/128", "", "Loopback Pseudo-Interface 1", 331, 6),
    r("2a02:1210:5e0c:a100::/64", "", "WLAN", 291, 6),
    r("fe80::/64", "", "WLAN", 291, 6),
  ];
}

export async function getWifi(): Promise<WifiInfo[]> {
  return [
    {
      interfaceId: "{A1B2C3D4-0001}",
      description: "Intel(R) Wi-Fi 6 AX201 160MHz",
      connected: true,
      state: "verbunden",
      ssid: "FRITZ!Box 7590 XY",
      bssid: "3C-A6-2F-11-22-34",
      profile: "FRITZ!Box 7590 XY",
      signalQuality: 78,
      rssiDbm: -58,
      channel: 36,
      frequencyMhz: 5180,
      band: "5 GHz",
      phy: "802.11ax (Wi-Fi 6/6E)",
      rxMbps: 866.7,
      txMbps: 721.6,
      auth: "WPA2-Personal",
      cipher: "AES (CCMP)",
      error: null,
    },
  ];
}

export async function getPublicIp(): Promise<PublicIp> {
  await delay(400);
  return { ipv4: "203.0.113.42", ipv6: "2a02:1210:5e0c:a100:1c2d:3e4f:5a6b:7c8d" };
}
