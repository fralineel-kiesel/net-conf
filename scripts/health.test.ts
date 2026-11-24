// Test der Health-Check-Bewertung (ohne Test-Framework): npm test
import { evaluate, runHealthCheck, summary, type Facts } from "../src/health.ts";
import type { AdapterInfo, PingResult } from "../src/types.ts";
import { normalizeMac, scanBlockReason, maskToPrefix } from "../src/netutil.ts";

const eq = (a: unknown, b: unknown, msg: string) => {
  if (a !== b) { console.log("FAIL", msg, JSON.stringify(a), "!=", JSON.stringify(b)); process.exitCode = 1; }
  else console.log("ok  ", msg);
};
const has = (text: string, part: string, msg: string) => eq(text.includes(part), true, `${msg} (${text})`);

const adapter = (patch: Partial<AdapterInfo> = {}): AdapterInfo => ({
  id: "{1}", name: "WLAN", description: "", connected: true, mac: "A4-C3-F0-12-34-56",
  ipv4: [{ address: "192.168.1.42", subnetMask: "255.255.255.0" }], ipv6: [],
  gateways: ["192.168.1.1"], dnsServers: ["192.168.1.1"], dhcpEnabled: true, dhcpServer: "192.168.1.1",
  leaseObtained: null, leaseExpires: null, dnsSuffix: "", ...patch,
});
const st = (f: Facts) => evaluate(f).stages.map((s) => s.status).join(",");
const ok = { ok: true, ms: 20, address: "93.184.215.14", error: null };
const bad = { ok: false, ms: 0, address: null, error: "Zeitüberschreitung" };

// Alles gut
let f: Facts = { adapters: [adapter()], gateway: { target: "192.168.1.1", rtt: 3 }, dns: [{ target: "192.168.1.1", rtt: 2 }], resolve: ok, internet: [{ target: "1.1.1.1", rtt: 14 }] };
eq(st(f), "ok,ok,ok,ok,ok,ok", "alles ok");
has(summary(evaluate(f)), "Alles in Ordnung", "Zusammenfassung ok");

// Kein Adapter
f = { adapters: [adapter({ connected: false })] };
eq(st(f), "fail,skip,skip,skip,skip,skip", "kein Adapter: Rest übersprungen");
has(evaluate(f).diagnosis, "Adapter", "Diagnose Adapter");

// APIPA
f = { adapters: [adapter({ ipv4: [{ address: "169.254.12.7", subnetMask: "255.255.0.0" }], gateways: [] })] };
eq(st(f), "fail,fail,skip,skip,skip,skip", "APIPA: Adapter + IP rot");
has(evaluate(f).diagnosis, "DHCP", "Diagnose DHCP");
has(evaluate(f).stages[1].hint ?? "", "DHCP-Server", "Hinweis DHCP-Server");

// Gateway ok, DNS-Auflösung scheitert, Internet per IP ok → DNS-Problem
f = { adapters: [adapter()], gateway: { target: "192.168.1.1", rtt: 3 }, dns: [{ target: "192.168.1.1", rtt: 2 }], resolve: bad, internet: [{ target: "1.1.1.1", rtt: 14 }] };
eq(evaluate(f).stages[4].status, "fail", "Auflösung rot");
has(evaluate(f).diagnosis, "DNS-Problem", "Diagnose DNS-Problem");

// DNS-Server blockiert Ping, Auflösung klappt → nur Warnung
f = { adapters: [adapter()], gateway: { target: "192.168.1.1", rtt: 3 }, dns: [{ target: "192.168.1.1", rtt: null }], resolve: ok, internet: [{ target: "1.1.1.1", rtt: 14 }] };
eq(evaluate(f).stages[3].status, "warn", "DNS-Ping blockiert = Warnung");
has(summary(evaluate(f)), "Warnungen", "Zusammenfassung mit Warnungen");

// DNS-Server weg und Auflösung kaputt → Fehler
f = { ...f, resolve: bad, internet: [{ target: "1.1.1.1", rtt: null }, { target: "8.8.8.8", rtt: null }] };
eq(evaluate(f).stages[3].status, "fail", "DNS-Server + Auflösung kaputt = Fehler");
has(evaluate(f).diagnosis, "hinter dem Router", "Diagnose hinter dem Router");

// Router blockiert Ping, Internet geht → Gateway nur Warnung
f = { adapters: [adapter()], gateway: { target: "192.168.1.1", rtt: null }, dns: [{ target: "192.168.1.1", rtt: null }], resolve: ok, internet: [{ target: "1.1.1.1", rtt: 14 }] };
eq(evaluate(f).stages[2].status, "warn", "Gateway ohne Ping, Internet ok = Warnung");
// Alles tot
f = { adapters: [adapter()], gateway: { target: "192.168.1.1", rtt: null }, dns: [{ target: "192.168.1.1", rtt: null }], resolve: bad, internet: [{ target: "1.1.1.1", rtt: null }, { target: "8.8.8.8", rtt: null }] };
eq(evaluate(f).stages[2].status, "fail", "Gateway tot = Fehler");
has(evaluate(f).diagnosis, "beim Gateway", "Diagnose Gateway");

// Ablauf mit Fallback 8.8.8.8 (1.1.1.1 antwortet nicht)
const pinged: string[] = [];
const deps = {
  getAdapters: async () => [adapter()],
  ping: async (target: string): Promise<PingResult> => {
    pinged.push(target);
    const rtt = target === "1.1.1.1" ? null : 5;
    return { address: target, status: rtt === null ? "timeout" : "ok", rttMs: rtt, ttl: 64, message: null };
  },
  resolve: async () => ({ addresses: ["93.184.215.14"], elapsedMs: 12 }),
};
const result = await runHealthCheck(deps, () => {});
eq(pinged.join(" "), "192.168.1.1 192.168.1.1 1.1.1.1 8.8.8.8", "Reihenfolge: Gateway, DNS, 1.1.1.1, Fallback 8.8.8.8");
eq(result.stages[5].value, "8.8.8.8: 5 ms", "Internet über Fallback");

// Hilfsfunktionen
eq(normalizeMac("aa:bb:cc:01:02:03"), "AA-BB-CC-01-02-03", "MAC mit Doppelpunkten");
eq(normalizeMac("AABBCC010203"), "AA-BB-CC-01-02-03", "MAC ohne Trenner");
eq(normalizeMac("01-00-5E-00-00-16"), null, "Multicast-MAC abgelehnt");
eq(normalizeMac("AA-BB:CC-01-02-03"), null, "gemischte Trenner abgelehnt");
eq(maskToPrefix("255.255.252.0"), 22, "Maske /22");
eq(scanBlockReason({ address: "192.168.1.5", subnetMask: "255.255.255.0" }), null, "/24 privat erlaubt");
eq(scanBlockReason({ address: "10.0.0.5", subnetMask: "255.0.0.0" }), "/8 zu gross (max. /22)", "/8 zu gross");
eq(scanBlockReason({ address: "100.64.1.5", subnetMask: "255.255.255.0" }), "kein privates Netz", "CGNAT nicht privat");
