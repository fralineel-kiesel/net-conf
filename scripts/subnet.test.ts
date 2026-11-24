// Tests des Subnetz-Rechners (ohne Test-Framework): npm test
import { calc, hostsToPrefix, maskIntToPrefix, parseInput, parseMask, prefixToMask, split, splitByCount, splitByHosts, toBinary, addrType, inNet, ip } from "../src/subnet.ts";
import { ipToInt } from "../src/netutil.ts";

const eq = (a: unknown, b: unknown, msg: string) => {
  const A = JSON.stringify(a);
  const B = JSON.stringify(b);
  if (A !== B) { console.log("FAIL", msg, A, "!=", B); process.exitCode = 1; }
  else console.log("ok  ", msg);
};

/** Kurzform: alle Werte eines Netzes als Text */
function summary(input: string) {
  const r = parseInput(input);
  if ("error" in r) return r.error;
  const s = calc(r.ip, r.prefix);
  return {
    net: ip(s.network), bc: ip(s.broadcast), mask: ip(s.mask), wild: ip(s.wildcard),
    first: ip(s.first), last: ip(s.last), usable: s.usable, total: s.total,
  };
}

// --- Masken: die klassische JS-Falle (Vorzeichen) ---------------------------
eq(prefixToMask(24), 0xffffff00, "/24 = 0xFFFFFF00 (nicht negativ)");
eq(ip(prefixToMask(24)), "255.255.255.0", "/24 als Text");
eq(ip(prefixToMask(1)), "128.0.0.0", "/1 (höchstes Bit = Vorzeichen in JS)");
eq(ip(prefixToMask(0)), "0.0.0.0", "/0 (x << 32 wäre in JS x << 0)");
eq(ip(prefixToMask(32)), "255.255.255.255", "/32");
for (let p = 0; p <= 32; p++) {
  const m = prefixToMask(p);
  if (m < 0 || maskIntToPrefix(m) !== p) eq(maskIntToPrefix(m), p, `Rundreise /${p}`);
}
eq(true, true, "Rundreise Präfix → Maske → Präfix für /0 bis /32");
eq(maskIntToPrefix(ipToInt("255.0.255.0")!), null, "Maske mit Lücke abgelehnt");
eq(parseMask("255.255.255.0"), 24, "Maske 255.255.255.0");
eq(parseMask("/25"), 25, "Maske /25");
eq(parseMask("30"), 30, "Maske 30");
eq(typeof parseMask("/33"), "string", "/33 abgelehnt");
eq(typeof parseMask("255.255.0.255"), "string", "255.255.0.255 abgelehnt");

// --- Netze ------------------------------------------------------------------
eq(summary("10.20.30.40/8"), { net: "10.0.0.0", bc: "10.255.255.255", mask: "255.0.0.0", wild: "0.255.255.255", first: "10.0.0.1", last: "10.255.255.254", usable: 16777214, total: 16777216 }, "/8");
eq(summary("172.16.5.4/16"), { net: "172.16.0.0", bc: "172.16.255.255", mask: "255.255.0.0", wild: "0.0.255.255", first: "172.16.0.1", last: "172.16.255.254", usable: 65534, total: 65536 }, "/16");
eq(summary("192.168.10.55/24"), { net: "192.168.10.0", bc: "192.168.10.255", mask: "255.255.255.0", wild: "0.0.0.255", first: "192.168.10.1", last: "192.168.10.254", usable: 254, total: 256 }, "/24");
eq(summary("192.168.10.200/25"), { net: "192.168.10.128", bc: "192.168.10.255", mask: "255.255.255.128", wild: "0.0.0.127", first: "192.168.10.129", last: "192.168.10.254", usable: 126, total: 128 }, "/25 (obere Hälfte)");
eq(summary("192.168.10.5/30"), { net: "192.168.10.4", bc: "192.168.10.7", mask: "255.255.255.252", wild: "0.0.0.3", first: "192.168.10.5", last: "192.168.10.6", usable: 2, total: 4 }, "/30");
eq(summary("10.0.0.1/31"), { net: "10.0.0.0", bc: "10.0.0.1", mask: "255.255.255.254", wild: "0.0.0.1", first: "10.0.0.0", last: "10.0.0.1", usable: 2, total: 2 }, "/31 (RFC 3021: beide nutzbar)");
eq(summary("10.0.0.9/32"), { net: "10.0.0.9", bc: "10.0.0.9", mask: "255.255.255.255", wild: "0.0.0.0", first: "10.0.0.9", last: "10.0.0.9", usable: 1, total: 1 }, "/32 (eine Adresse)");
eq(summary("200.1.2.3/1").net, "128.0.0.0", "/1 obere Hälfte");
eq(summary("255.255.255.255/24").bc, "255.255.255.255", "höchste Adresse ohne Überlauf");

// --- Eingabeformen ------------------------------------------------------------
eq(summary("192.168.10.55 255.255.255.0").net, "192.168.10.0", "IP + Maske mit Leerzeichen");
eq(summary("192.168.10.55/255.255.255.192").net, "192.168.10.0", "IP/Maske");
const sep = parseInput("192.168.10.55", "/26");
eq("error" in sep ? sep.error : sep.prefix, 26, "Maske im eigenen Feld");
const guess = parseInput("172.20.1.1");
eq("error" in guess ? guess.error : [guess.prefix, guess.guessed], [16, true], "ohne Maske: Klasse B → /16 (geschätzt)");
eq("error" in parseInput("192.168.1.300/24"), true, "Oktett > 255 abgelehnt");
eq("error" in parseInput("192.168.1.1/24", "/24"), true, "Maske doppelt angegeben");
eq("error" in parseInput(""), true, "leer");

// --- Klasse und Typ -----------------------------------------------------------
eq(calc(ipToInt("10.1.1.1")!, 8).cls, "A", "Klasse A");
eq(calc(ipToInt("172.16.1.1")!, 16).cls, "B", "Klasse B");
eq(calc(ipToInt("192.168.1.1")!, 24).cls, "C", "Klasse C");
eq(calc(ipToInt("239.1.1.1")!, 24).cls, "D", "Klasse D");
eq(addrType(ipToInt("172.31.255.1")!), "privat (RFC 1918)", "172.31 privat");
eq(addrType(ipToInt("172.32.0.1")!), "öffentlich", "172.32 öffentlich");
eq(addrType(ipToInt("169.254.10.1")!), "APIPA / Link-Local", "APIPA");
eq(addrType(ipToInt("127.0.0.1")!), "Loopback", "Loopback");
eq(addrType(ipToInt("224.0.0.251")!), "Multicast", "Multicast");
eq(addrType(ipToInt("8.8.8.8")!), "öffentlich", "8.8.8.8 öffentlich");

// --- Binär --------------------------------------------------------------------
eq(toBinary(ipToInt("192.168.10.55")!), "11000000.10101000.00001010.00110111", "Binär IP");
eq(toBinary(prefixToMask(25)), "11111111.11111111.11111111.10000000", "Binär /25");

// --- Subnetting ---------------------------------------------------------------
const base = ipToInt("192.168.10.0")!;
const four = splitByCount(base, 24, 4);
eq(typeof four === "string" ? four : [four.prefix, four.count, four.networks.map(ip)], [26, 4, ["192.168.10.0", "192.168.10.64", "192.168.10.128", "192.168.10.192"]], "/24 in 4 Subnetze");
eq(typeof splitByCount(base, 24, 3), "string", "3 ist keine Zweierpotenz");
eq(typeof splitByCount(base, 31, 4), "string", "/31 in 4 geht nicht");
const big = splitByCount(ipToInt("10.0.0.0")!, 8, 65536, 10);
eq(typeof big === "string" ? big : [big.count, big.networks.length, ip(big.networks[9])], [65536, 10, "10.0.9.0"], "Auflistung begrenzt");
eq(hostsToPrefix(50), 26, "50 Hosts → /26 (62 nutzbar)");
eq(hostsToPrefix(62), 26, "62 Hosts → /26");
eq(hostsToPrefix(63), 25, "63 Hosts → /25");
eq(hostsToPrefix(2), 30, "2 Hosts → /30 (klassisch)");
eq(hostsToPrefix(0), null, "0 Hosts ungültig");
const hosts = splitByHosts(base, 24, 100);
eq(typeof hosts === "string" ? hosts : [hosts.prefix, hosts.count], [25, 2], "100 Hosts im /24 → 2× /25");
eq(typeof splitByHosts(base, 24, 300), "string", "300 Hosts passen nicht in /24");
const tail = split(ipToInt("255.255.255.0")!, 24, 26);
eq(typeof tail === "string" ? tail : ip(tail.networks[3]), "255.255.255.192", "Subnetze am oberen Ende ohne Überlauf");

// --- Liegt IP im Netz? --------------------------------------------------------
eq(inNet(ipToInt("192.168.10.77")!, base, 24), true, "192.168.10.77 in 192.168.10.0/24");
eq(inNet(ipToInt("192.168.11.1")!, base, 24), false, "192.168.11.1 nicht in /24");
eq(inNet(ipToInt("192.168.10.200")!, base, 25), false, ".200 nicht in .0/25");
eq(inNet(ipToInt("1.2.3.4")!, 0, 0), true, "alles liegt in 0.0.0.0/0");
