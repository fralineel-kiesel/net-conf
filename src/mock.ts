// Mock-Backend für die Entwicklung im Browser (`npm run dev`).
// Simuliert Adapterdaten und die (deutsche) Ausgabe von ipconfig/ping.
//
// Tipp: Mit `?admin=1` in der URL tut der Mock so, als liefe die App
// mit Administratorrechten.
import { events } from "./events";
import { validateTarget } from "./validate";
import type { AdapterInfo, NetCommand } from "./types";

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
  if (command.kind === "ping") {
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
  }
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
