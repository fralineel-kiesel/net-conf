// Health-Check: prüft die Netzwerk-Kette Stufe für Stufe und sagt, wo sie bricht.
//
//   1 Adapter          verbundener Adapter mit Gateway?
//   2 IP-Konfiguration gültige IPv4, kein 169.254.x.x (APIPA = DHCP gescheitert)
//   3 Gateway          Ping (ICMP) zum Router
//   4 DNS-Server       Ping zu jedem IPv4-DNS-Server
//   5 DNS-Auflösung    example.com über den System-Resolver
//   6 Internet         Ping 1.1.1.1 (sonst 8.8.8.8) – ohne DNS
//
// Aufbau: Der Ablauf (`runHealthCheck`) sammelt nur FAKTEN (Antwort ja/nein,
// Zeiten). Die Bewertung (`evaluate`) ist eine reine Funktion – testbar mit
// `npm test` und im Mock-Modus identisch mit der echten App.
//
// Wichtig: Manche Geräte beantworten keine Pings (Router, Firmen-DNS). Darum
// wird ein fehlender Ping erst am Ende bewertet: Klappen Auflösung/Internet,
// ist es nur eine [WARNUNG].
import { ipv4Dns, ipv4Gateway, isApipa, isIpv4, maskToPrefix, primaryOf } from "./netutil.ts";
import type { AdapterInfo, PingResult, ResolveResult } from "./types";

export type StageId = "adapter" | "ip" | "gateway" | "dns" | "resolve" | "internet";
export type StageStatus = "ok" | "warn" | "fail" | "skip" | "pending" | "running";

export interface StageResult {
  id: StageId;
  title: string;
  status: StageStatus;
  /** Kurzer Wert, z. B. "3 ms" oder "WLAN" */
  value: string;
  /** Kurzer deutscher Hinweis bei Problemen */
  hint: string | null;
}

export interface Ping {
  target: string;
  /** null = keine Antwort */
  rtt: number | null;
}

/** Gesammelte Fakten. `undefined` = (noch) nicht geprüft. */
export interface Facts {
  adapters?: AdapterInfo[];
  gateway?: Ping;
  dns?: Ping[];
  resolve?: { ok: boolean; ms: number; address: string | null; error: string | null };
  internet?: Ping[];
}

export const RESOLVE_NAME = "example.com";
export const INTERNET_TARGETS = ["1.1.1.1", "8.8.8.8"];

/** Schwellen für [WARNUNG] (ms) */
const SLOW_GATEWAY = 50;
const SLOW_RESOLVE = 1000;
const SLOW_INTERNET = 150;

export const STAGE_TITLES: Record<StageId, string> = {
  adapter: "Adapter",
  ip: "IP-Konfiguration",
  gateway: "Gateway",
  dns: "DNS-Server",
  resolve: "DNS-Auflösung",
  internet: "Internet (ohne DNS)",
};
const ORDER: StageId[] = ["adapter", "ip", "gateway", "dns", "resolve", "internet"];

const ms = (v: number) => (v < 1 ? "<1 ms" : `${v} ms`);

/**
 * Adapter für die Prüfung: der primäre (mit Gateway). Gibt es keinen, den
 * verbundenen, der am ehesten das Problem zeigt: mit APIPA-Adresse, sonst mit DHCP.
 */
export function chooseAdapter(list: AdapterInfo[]): AdapterInfo | undefined {
  const primary = primaryOf(list);
  if (primary) return primary;
  const connected = list.filter((a) => a.connected);
  return (
    connected.find((a) => a.ipv4.some((e) => isApipa(e.address))) ??
    connected.find((a) => a.dhcpEnabled && a.ipv4.length > 0) ??
    connected.find((a) => a.ipv4.length > 0) ??
    connected[0]
  );
}

export interface Evaluation {
  stages: StageResult[];
  diagnosis: string;
  /** true = mindestens eine Stufe mit [FEHLER] */
  failed: boolean;
}

/** Bewertet die Fakten. `running` = Stufe, die gerade läuft (Anzeige). */
export function evaluate(f: Facts, running: StageId | null = null): Evaluation {
  const st = {} as Record<StageId, StageResult>;
  const set = (id: StageId, status: StageStatus, value = "", hint: string | null = null) =>
    (st[id] = { id, title: STAGE_TITLES[id], status, value, hint });
  for (const id of ORDER) set(id, id === running ? "running" : "pending", id === running ? "prüfe …" : "");

  const adapter = f.adapters ? chooseAdapter(f.adapters) : undefined;
  const gatewayIp = ipv4Gateway(adapter);
  const anyConnected = f.adapters?.some((a) => a.connected) ?? false;
  const resolveOk = f.resolve?.ok === true;
  const internetPing = f.internet?.find((p) => p.rtt !== null);
  const internetOk = internetPing !== undefined;
  const laterOk = resolveOk || internetOk;

  // --- 1 Adapter -------------------------------------------------------------
  let skipRest: string | null = null;
  if (f.adapters) {
    if (!anyConnected) {
      set("adapter", "fail", "kein Adapter verbunden", "Kabel einstecken bzw. mit dem WLAN verbinden. Flugmodus aus?");
      skipRest = "kein verbundener Adapter";
    } else if (!gatewayIp) {
      set(
        "adapter",
        "fail",
        `${adapter?.name ?? "?"}: verbunden, aber ohne Standardgateway`,
        "Ohne Gateway (Router) gibt es kein Internet. Meist hat DHCP nicht geklappt – siehe Stufe 2.",
      );
      skipRest = "kein Standardgateway";
    } else {
      set("adapter", "ok", adapter!.name);
    }
  }

  // --- 2 IP-Konfiguration ----------------------------------------------------
  if (f.adapters && adapter) {
    const v4 = adapter.ipv4.filter((e) => isIpv4(e.address));
    const good = v4.find((e) => !isApipa(e.address));
    if (v4.length === 0) {
      set("ip", "fail", "keine IPv4-Adresse", "Der Adapter hat keine IPv4-Adresse. Aktionen → Release + Renew versuchen.");
      skipRest = "keine IPv4-Adresse";
    } else if (!good) {
      set(
        "ip",
        "fail",
        `${v4[0].address} (APIPA)`,
        "169.254.x.x heisst: Der DHCP-Server (meist der Router) war nicht erreichbar, Windows hat sich eine Notadresse gegeben. Router/Kabel prüfen, dann Aktionen → Release + Renew.",
      );
      skipRest = "keine gültige IPv4 (APIPA)";
    } else {
      const prefix = maskToPrefix(good.subnetMask);
      set("ip", "ok", `${good.address}${prefix !== null ? "/" + prefix : ""} (${adapter.dhcpEnabled ? "DHCP" : "statisch"})`);
    }
  } else if (f.adapters) {
    set("ip", "skip", "", "übersprungen – kein verbundener Adapter");
  }

  if (skipRest) {
    for (const id of ["gateway", "dns", "resolve", "internet"] as StageId[]) {
      set(id, "skip", "", `übersprungen – ${skipRest}`);
    }
    return { stages: ORDER.map((id) => st[id]), diagnosis: diagnose(f, adapter, anyConnected), failed: true };
  }

  // --- 3 Gateway ---------------------------------------------------------------
  if (f.gateway) {
    const g = f.gateway;
    if (g.rtt !== null) {
      if (g.rtt > SLOW_GATEWAY) {
        set("gateway", "warn", `${g.target}: ${ms(g.rtt)}`, "Hohe Latenz zum Router – WLAN-Empfang schwach oder Netz ausgelastet.");
      } else set("gateway", "ok", `${g.target}: ${ms(g.rtt)}`);
    } else if (laterOk) {
      set(
        "gateway",
        "warn",
        `${g.target}: keine Antwort`,
        "Der Router antwortet nicht auf Ping, dahinter klappt aber alles – er blockiert vermutlich ICMP.",
      );
    } else {
      set("gateway", "fail", `${g.target}: keine Antwort`, "Router nicht erreichbar: WLAN/Kabel prüfen, ist der Router eingeschaltet?");
    }
  }

  // --- 4 DNS-Server --------------------------------------------------------------
  if (f.dns) {
    const v6 = (adapter?.dnsServers.length ?? 0) - ipv4Dns(adapter).length;
    const v6Note = v6 > 0 ? ` (+${v6} IPv6, nicht geprüft)` : "";
    if (f.dns.length === 0) {
      if (v6 > 0) set("dns", "skip", `nur IPv6-DNS-Server${v6Note}`, "IPv6 wird per Ping nicht geprüft – Stufe 5 zeigt, ob DNS klappt.");
      else set("dns", resolveOk ? "warn" : "fail", "keine DNS-Server eingetragen", "Ohne DNS-Server können keine Namen aufgelöst werden. DHCP bzw. Adapter-Einstellungen prüfen.");
    } else {
      const text = f.dns.map((d) => `${d.target}: ${d.rtt === null ? "keine Antwort" : ms(d.rtt)}`).join(", ") + v6Note;
      const silent = f.dns.filter((d) => d.rtt === null);
      if (silent.length === 0) set("dns", "ok", text);
      else if (resolveOk || f.resolve === undefined) {
        set("dns", "warn", text, "Antwortet nicht auf Ping – blockiert evtl. ICMP. Die Namensauflösung klappt trotzdem.");
      } else if (silent.length < f.dns.length) {
        set("dns", "warn", text, "Nicht alle DNS-Server sind erreichbar.");
      } else {
        set("dns", "fail", text, "Kein DNS-Server erreichbar – Namen können nicht aufgelöst werden.");
      }
      // Vor Stufe 5 steht noch nicht fest, ob es nur eine Warnung ist
      if (silent.length > 0 && f.resolve === undefined) st.dns.hint = "Antwortet nicht auf Ping – Bewertung nach Stufe 5.";
    }
  }

  // --- 5 DNS-Auflösung --------------------------------------------------------
  if (f.resolve) {
    const r = f.resolve;
    if (r.ok) {
      const value = `${RESOLVE_NAME} → ${r.address ?? "?"} in ${ms(r.ms)}`;
      if (r.ms > SLOW_RESOLVE) set("resolve", "warn", value, "Die Namensauflösung ist sehr langsam – DNS-Server überlastet oder schlecht erreichbar.");
      else set("resolve", "ok", value);
    } else {
      set(
        "resolve",
        "fail",
        `${RESOLVE_NAME}: ${r.error ?? "keine Antwort"}`,
        internetOk
          ? "DNS-Problem: Das Internet ist per IP erreichbar, aber Namen werden nicht aufgelöst. Aktionen → DNS-Cache leeren oder anderen DNS-Server eintragen."
          : "Namen werden nicht aufgelöst.",
      );
    }
  }

  // --- 6 Internet ohne DNS ------------------------------------------------------
  if (f.internet) {
    if (internetPing) {
      const value = `${internetPing.target}: ${ms(internetPing.rtt!)}`;
      if (internetPing.rtt! > SLOW_INTERNET) set("internet", "warn", value, "Hohe Latenz ins Internet – Leitung ausgelastet oder Mobilfunk/VPN.");
      else set("internet", "ok", value);
    } else {
      const value = f.internet.map((p) => `${p.target}: keine Antwort`).join(", ");
      if (resolveOk) {
        set("internet", "warn", value, "Kein Ping ins Internet, die Namensauflösung klappt aber – vermutlich blockiert eine Firewall ICMP. Im Browser testen.");
      } else {
        set("internet", "fail", value, "Keine Verbindung ins Internet.");
      }
    }
  }

  const stages = ORDER.map((id) => st[id]);
  return { stages, diagnosis: diagnose(f, adapter, anyConnected), failed: stages.some((s) => s.status === "fail") };
}

/** Eine Zeile: Wo bricht die Kette? */
export function diagnose(f: Facts, adapter: AdapterInfo | undefined, anyConnected: boolean): string {
  if (!f.adapters) return "";
  if (!anyConnected) return "Kette bricht beim Adapter: kein Netzwerk verbunden (Kabel/WLAN).";
  const v4 = adapter?.ipv4.filter((e) => isIpv4(e.address)) ?? [];
  if (v4.length > 0 && v4.every((e) => isApipa(e.address))) {
    return "Kette bricht bei DHCP: keine Adresse vom DHCP-Server bekommen (169.254.x.x).";
  }
  if (v4.length === 0) return "Kette bricht bei der IP-Konfiguration: keine IPv4-Adresse.";
  if (!ipv4Gateway(adapter)) return "Kette bricht beim Adapter: kein Standardgateway eingetragen.";
  if (!f.gateway || !f.dns || !f.resolve || !f.internet) return ""; // noch nicht fertig

  const gw = f.gateway.rtt !== null;
  const dns = f.resolve.ok;
  const net = f.internet.some((p) => p.rtt !== null);
  if (!gw && !dns && !net) return "Kette bricht beim Gateway: Router nicht erreichbar.";
  if (!dns && !net) return "Kette bricht hinter dem Router: lokales Netz ok, aber kein Internet (Router/Provider).";
  if (!dns && net) return "DNS-Problem: Internet per IP erreichbar, aber Namen werden nicht aufgelöst.";
  if (dns && !net) return "Unklar: Namen werden aufgelöst, aber kein Ping ins Internet – vermutlich blockiert eine Firewall ICMP.";
  return "";
}

/** Abschlusszeile inkl. "alles ok" (wenn diagnose() nichts findet). */
export function summary(e: Evaluation): string {
  if (e.diagnosis) return e.diagnosis;
  if (e.stages.some((s) => s.status === "warn")) return "Alles erreichbar, aber mit Warnungen (siehe oben).";
  return "Alles in Ordnung: Adapter, Gateway, DNS und Internet funktionieren.";
}

// ---------------------------------------------------------------------------
// Ablauf
// ---------------------------------------------------------------------------

export interface HealthDeps {
  getAdapters(): Promise<AdapterInfo[]>;
  ping(target: string, timeoutMs: number): Promise<PingResult>;
  resolve(name: string, timeoutMs: number): Promise<ResolveResult>;
}

/** Ein Ping, Fehler (z. B. ungültiges Ziel) zählen als "keine Antwort". */
async function tryPing(deps: HealthDeps, target: string, timeoutMs: number): Promise<Ping> {
  try {
    const r = await deps.ping(target, timeoutMs);
    return { target, rtt: r.status === "ok" ? r.rttMs : null };
  } catch {
    return { target, rtt: null };
  }
}

/** Führt alle Stufen nacheinander aus. `onUpdate` wird nach jedem Schritt aufgerufen. */
export async function runHealthCheck(deps: HealthDeps, onUpdate: (e: Evaluation) => void): Promise<Evaluation> {
  const f: Facts = {};
  const step = (running: StageId | null) => {
    const e = evaluate(f, running);
    onUpdate(e);
    return e;
  };

  step("adapter");
  f.adapters = await deps.getAdapters();
  let e = step("gateway");
  if (e.stages[2].status === "skip") return step(null);

  const adapter = chooseAdapter(f.adapters)!;
  const gw = ipv4Gateway(adapter)!;
  // Zwei Versuche: der erste Ping kann auf eine ARP-Auflösung warten
  let g = await tryPing(deps, gw, 1000);
  if (g.rtt === null) g = await tryPing(deps, gw, 1000);
  f.gateway = g;
  step("dns");

  f.dns = [];
  for (const server of ipv4Dns(adapter)) {
    f.dns.push(await tryPing(deps, server, 1000));
    step("dns");
  }
  step("resolve");

  try {
    const r = await deps.resolve(RESOLVE_NAME, 3000);
    f.resolve = { ok: true, ms: r.elapsedMs, address: r.addresses.find(isIpv4) ?? r.addresses[0] ?? null, error: null };
  } catch (err) {
    f.resolve = { ok: false, ms: 0, address: null, error: typeof err === "string" ? err : String(err) };
  }
  e = step("internet");

  f.internet = [];
  for (const target of INTERNET_TARGETS) {
    const p = await tryPing(deps, target, 1500);
    f.internet.push(p);
    if (p.rtt !== null) break; // Fallback nur, wenn 1.1.1.1 nicht antwortet
  }
  e = step(null);
  return e;
}

const LABEL: Record<StageStatus, string> = {
  ok: "[OK]",
  warn: "[WARNUNG]",
  fail: "[FEHLER]",
  skip: "[ÜBERSPRUNGEN]",
  pending: "[ ]",
  running: "[...]",
};
export const statusLabel = (s: StageStatus) => LABEL[s];

/** Ergebnis als Text (Kopieren, Konsole, Tickets). */
export function reportLines(e: Evaluation, when: string): string[] {
  const lines = [`Net-Conf Health-Check – ${when}`, ""];
  e.stages.forEach((s, i) => {
    const value = s.value || s.hint; // übersprungen: Grund direkt in der Zeile
    lines.push(`${statusLabel(s.status).padEnd(15)} ${i + 1} ${s.title}${value ? ": " + value : ""}`);
    if (s.value && s.hint) lines.push(`${" ".repeat(18)}${s.hint}`);
  });
  lines.push("", `Diagnose: ${summary(e)}`);
  return lines;
}
