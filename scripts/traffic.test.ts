// Tests für Phase 4b (ohne Test-Framework): Traffic-Skala, Formatierung,
// Kanal-Belegung, WLAN-Eingaben und Verbindungs-Filter. Start: npm test
import { TrafficScale, niceScale, TRAFFIC_STEPS } from "../src/pingscale.ts";
import { endpoint, fmtBytes, fmtDuration, fmtLink, fmtMByteRate, fmtMbit, hasRemote, matchesFilter, sortConnections } from "../src/traffic.ts";
import { channelUsage, hashBarText, passwordProblem, ssidLabel, ssidProblem } from "../src/wifiutil.ts";
import type { Connection, WifiBss } from "../src/types.ts";

const eq = (a: unknown, b: unknown, msg: string) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) { console.log("FAIL", msg, JSON.stringify(a), "!=", JSON.stringify(b)); process.exitCode = 1; } else console.log("ok  ", msg);
};

// ---- Traffic-Skala: 1, 2, 5 … 1000 Mbit/s, wächst sofort, schrumpft langsam
eq(niceScale(0, TRAFFIC_STEPS), 1, "0 Mbit/s -> Skala 1");
eq(niceScale(0.3, TRAFFIC_STEPS), 1, "0.3 -> 1");
eq(niceScale(1.2, TRAFFIC_STEPS), 2, "1.2 -> 2");
eq(niceScale(87, TRAFFIC_STEPS), 100, "87 -> 100");
eq(niceScale(1001, TRAFFIC_STEPS), 2000, "1001 -> 2000 (volle 1000er)");
const s = new TrafficScale();
const hist: (number | null)[] = [];
const push = (v: number | null) => { hist.push(v); return s.update(hist.slice(-60)); };
for (let i = 0; i < 5; i++) push(0.4);
eq(s.max, 1, "Leerlauf -> Skala 1");
eq(push(null), 1, "Lücke (keine Messung) ändert nichts");
eq(push(140), 200, "Download-Spitze 140 -> sofort 200");
for (let i = 0; i < 59; i++) push(3);
eq(s.max, 200, "Spitze noch sichtbar -> bleibt 200");
for (let i = 0; i < 9; i++) push(3);
eq(s.max, 200, "erst 9 ruhige Messungen ohne Spitze -> noch 200");
push(3);
eq(s.max, 5, "nach 10 ruhigen Messungen -> 5 (3 ≤ 80 % von 5)");
s.reset();
eq(s.max, 1, "reset -> 1");

// ---- Formatierung
eq(fmtMbit(12_400_000), "12.4 Mbit/s", "12.4 Mbit/s");
eq(fmtMbit(0), "0.00 Mbit/s", "0 Mbit/s");
eq(fmtMbit(512_300_000), "512 Mbit/s", "512 Mbit/s");
eq(fmtMByteRate(12_400_000), "1.55 MB/s", "12.4 Mbit/s = 1.55 MB/s");
eq(fmtBytes(123_456_789), "123.5 MB", "MB");
eq(fmtBytes(2_345_000_000), "2.35 GB", "GB");
eq(fmtLink(1e9), "1 Gbit/s", "1 Gbit/s");
eq(fmtLink(2.5e9), "2.5 Gbit/s", "2.5 Gbit/s");
eq(fmtLink(866_700_000), "866.7 Mbit/s", "866.7 Mbit/s");
eq(fmtLink(100e6), "100 Mbit/s", "100 Mbit/s");
eq(fmtDuration(5), "5 s", "5 s");
eq(fmtDuration(185), "3 min 05 s", "3 min 05 s");
eq(fmtDuration(3720), "1 h 02 min", "1 h 02 min");

// ---- WLAN
eq(hashBarText(0.78), "[########--]", "Signal 78 %");
eq(hashBarText(0), "[----------]", "Signal 0 %");
eq(hashBarText(1.5), "[##########]", "Signal > 100 % begrenzt");
eq(ssidLabel({ ssid: "" }), "<versteckt>", "versteckte SSID");
eq(passwordProblem("wpa2", "1234567") !== null, true, "WPA2: 7 Zeichen zu kurz");
eq(passwordProblem("wpa2", "12345678"), null, "WPA2: 8 Zeichen ok");
eq(passwordProblem("wpa2", "ab".repeat(32)), null, "WPA2: 64 Hex ok");
eq(passwordProblem("wpa3", "ab".repeat(32)) !== null, true, "WPA3: 64 Zeichen zu lang");
eq(passwordProblem("wpa2", "Grüezi-Welt") !== null, true, "Umlaut abgelehnt");
eq(passwordProblem("open", ""), null, "offen ohne Passwort");
eq(passwordProblem("open", "x") !== null, true, "offen mit Passwort abgelehnt");
const secret = "kurz";
eq(String(passwordProblem("wpa2", secret)).includes(secret), false, "Meldung enthält das Passwort nicht");
eq(ssidProblem("a".repeat(32)), null, "SSID 32 Byte ok");
eq(ssidProblem("ä".repeat(17)) !== null, true, "SSID 34 Byte zu lang");
eq(ssidProblem("") !== null, true, "SSID leer");

const ap = (ssid: string, channel: number, band: string): WifiBss =>
  ({ ssid, bssid: "x", signal: 50, rssiDbm: -60, frequencyMhz: 0, channel, band });
const usage = channelUsage(
  [ap("A", 6, "2,4 GHz"), ap("B", 6, "2,4 GHz"), ap("A", 6, "2,4 GHz"), ap("", 11, "2,4 GHz"), ap("A", 36, "5 GHz")],
  { channel: 36, band: "5 GHz" },
);
eq(usage.map((u) => u.band), ["2,4 GHz", "5 GHz"], "6 GHz ohne Netze fehlt");
eq(usage[0].rows.length, 13, "2,4 GHz: immer Kanal 1-13");
eq(usage[0].rows[5], { channel: 6, aps: 3, networks: ["A", "B"], own: false }, "Kanal 6: 3 AP, 2 Netze");
eq(usage[0].rows[10].networks, ["<versteckt>"], "Kanal 11: verstecktes Netz");
eq(usage[1].rows, [{ channel: 36, aps: 1, networks: ["A"], own: true }], "5 GHz: nur belegte, eigener markiert");

// ---- Verbindungen
const c = (p: Partial<Connection>): Connection => ({
  proto: "TCP", family: 4, localAddr: "192.168.1.42", localPort: 50000, remoteAddr: "140.82.121.4", remotePort: 443,
  state: "ESTABLISHED", pid: 1234, process: "chrome.exe", ...p,
});
const rows = [
  c({}),
  c({ localAddr: "0.0.0.0", localPort: 135, remoteAddr: "0.0.0.0", remotePort: 0, state: "LISTEN", pid: 1100, process: "svchost.exe" }),
  c({ proto: "UDP", localAddr: "0.0.0.0", localPort: 5353, remoteAddr: "", remotePort: 0, state: "", pid: 2200, process: "msedge.exe" }),
  c({ family: 6, localAddr: "::1", localPort: 49670, remoteAddr: "::1", remotePort: 49671, pid: 4, process: "System" }),
  c({ localAddr: "192.168.1.9", localPort: 51000, state: "TIME_WAIT", pid: 0, process: "System" }),
];
eq(endpoint("::1", 443, 6), "[::1]:443", "IPv6-Endpunkt in Klammern");
eq(endpoint("", 0, 4), "*:*", "UDP ohne Gegenstelle");
eq(rows.filter((r) => matchesFilter(r, "listen", "")).length, 2, "LISTEN-Filter (inkl. UDP)");
eq(rows.filter((r) => matchesFilter(r, "established", "")).length, 2, "ESTABLISHED-Filter");
eq(rows.filter((r) => matchesFilter(r, "all", "SVCHOST")).length, 1, "Textfilter ohne Gross/Klein");
eq(rows.filter((r) => matchesFilter(r, "all", ":443")).length, 2, "Textfilter auf Port");
eq(rows.filter(hasRemote).length, 3, "Auflösen nur mit echter Gegenstelle");
eq(sortConnections(rows, "local", "asc").map((r) => r.localAddr),
  ["0.0.0.0", "0.0.0.0", "192.168.1.9", "192.168.1.42", "::1"], "Lokal numerisch sortiert, IPv6 am Ende");
eq(sortConnections(rows, "pid", "desc").map((r) => r.pid), [2200, 1234, 1100, 4, 0], "PID absteigend");
