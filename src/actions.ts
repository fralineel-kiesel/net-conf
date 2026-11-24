// Aktionen der Seite "Aktionen" (F2) – Anzeige-Daten.
//
// WICHTIG: Was wirklich ausgeführt wird, steht nur im Backend
// (src-tauri/src/actions.rs). Das Frontend schickt nur die ID.
// Die Schritte hier dienen der Anzeige ("1 release > 2 warten > 3 renew")
// und dem Mock im Browser – bei Änderungen beide Seiten anpassen.
import type { ActionId } from "./types";

export type GroupId = "ip" | "dns" | "cache" | "adapter" | "repair";

export interface ActionStep {
  /** Kurzname für die Ablauf-Anzeige, z. B. "release" */
  short: string;
  /** Befehl (für Spalte und Mock), fehlt bei "warten" */
  cmd?: string;
  waitMs?: number;
  /** trennt die Verbindung (z. B. release) */
  disruptive?: boolean;
  /** stellt sie wieder her – läuft auch nach Fehler/Abbruch (z. B. renew) */
  restore?: boolean;
  /** Schritt nimmt den Adapternamen als Argument */
  perAdapter?: boolean;
}

export interface ActionDef {
  id: ActionId;
  group: GroupId;
  title: string;
  steps: ActionStep[];
  description: string;
  /** braucht Administratorrechte → Tag [ADMIN] */
  admin: boolean;
  /** unterbricht die Verbindung oder ist riskant → Tag [!] + Bestätigung */
  danger: boolean;
  /** none = gilt für alles, optional = Adapter oder alle, required = nur mit Adapter */
  adapter: "none" | "optional" | "required";
  /** ändert die IP-Konfiguration → danach Adapter neu laden */
  changesIp: boolean;
  /** danach Windows-Neustart nötig */
  reboot: boolean;
  success: string;
  /** Text für die Bestätigung (nur bei danger). {adapter} wird ersetzt. */
  confirm?: { title: string; message: string; confirmText: string };
}

export const GROUPS: { id: GroupId; title: string }[] = [
  { id: "ip", title: "IP / DHCP" },
  { id: "dns", title: "DNS" },
  { id: "cache", title: "CACHE & NAMEN" },
  { id: "adapter", title: "ADAPTER" },
  { id: "repair", title: "REPARATUR (NEUSTART NÖTIG)" },
];

const RELEASE: ActionStep = { short: "release", cmd: "ipconfig /release", disruptive: true, perAdapter: true };
const RENEW: ActionStep = { short: "renew", cmd: "ipconfig /renew", restore: true, perAdapter: true };
const WAIT2: ActionStep = { short: "warten", waitMs: 2000 };
const FLUSH: ActionStep = { short: "flushdns", cmd: "ipconfig /flushdns" };
const REGISTER: ActionStep = { short: "registerdns", cmd: "ipconfig /registerdns" };

export const ACTIONS: ActionDef[] = [
  // ---- IP / DHCP ----------------------------------------------------------
  {
    id: "release",
    group: "ip",
    title: "IP freigeben",
    steps: [RELEASE],
    description: "Gibt die per DHCP bezogene IPv4-Adresse zurück. Ohne Netz, bis „IP erneuern“ läuft.",
    admin: true,
    danger: true,
    adapter: "optional",
    changesIp: true,
    reboot: false,
    success: "IP-Adresse freigegeben – „IP erneuern“ holt eine neue",
    confirm: {
      title: "IP-Adresse freigeben?",
      message:
        "Die Verbindung wird getrennt ({adapter}). Danach hast du kein Netzwerk mehr, bis du „IP erneuern“ ausführst.",
      confirmText: "Freigeben",
    },
  },
  {
    id: "renew",
    group: "ip",
    title: "IP erneuern",
    steps: [RENEW],
    description: "Fordert beim DHCP-Server eine neue IPv4-Adresse an. Kann einige Sekunden dauern.",
    admin: true,
    danger: false,
    adapter: "optional",
    changesIp: true,
    reboot: false,
    success: "IP-Adresse erneuert",
  },
  {
    id: "releaseRenew",
    group: "ip",
    title: "Release + Renew",
    steps: [RELEASE, WAIT2, RENEW],
    description: "IP freigeben, 2 s warten, neue IP holen. Hilft bei IP-Konflikten oder nach einem Netzwechsel.",
    admin: true,
    danger: true,
    adapter: "optional",
    changesIp: true,
    reboot: false,
    success: "Release + Renew erfolgreich – neue IP bezogen",
    confirm: {
      title: "Release + Renew ausführen?",
      message:
        "Die Verbindung ({adapter}) wird kurz getrennt, meist nur wenige Sekunden. " +
        "Laufende Downloads, Remote-Sitzungen und Videocalls brechen dabei ab.",
      confirmText: "Ausführen",
    },
  },
  {
    id: "fullRefresh",
    group: "ip",
    title: "Voller Refresh",
    steps: [FLUSH, RELEASE, WAIT2, RENEW, REGISTER],
    description: "DNS-Cache leeren, IP neu beziehen und den Computernamen neu im DNS registrieren.",
    admin: true,
    danger: true,
    adapter: "optional",
    changesIp: true,
    reboot: false,
    success: "Voller Refresh erfolgreich",
    confirm: {
      title: "Vollen Refresh ausführen?",
      message:
        "Der DNS-Cache wird geleert und die Verbindung ({adapter}) kurz getrennt, um eine neue IP zu holen. " +
        "Laufende Downloads, Remote-Sitzungen und Videocalls brechen dabei ab.",
      confirmText: "Ausführen",
    },
  },
  // ---- DNS ----------------------------------------------------------------
  {
    id: "flushDns",
    group: "dns",
    title: "DNS-Cache leeren",
    steps: [FLUSH],
    description: "Löscht zwischengespeicherte DNS-Einträge. Hilft, wenn Webseiten auf alte Adressen zeigen.",
    admin: false,
    danger: false,
    adapter: "none",
    changesIp: false,
    reboot: false,
    success: "DNS-Cache geleert",
  },
  {
    id: "displayDns",
    group: "dns",
    title: "DNS-Cache anzeigen",
    steps: [{ short: "displaydns", cmd: "ipconfig /displaydns" }],
    description: "Zeigt alle zwischengespeicherten DNS-Einträge in der Konsole (kann lang werden).",
    admin: false,
    danger: false,
    adapter: "none",
    changesIp: false,
    reboot: false,
    success: "DNS-Cache in der Konsole ausgegeben",
  },
  {
    id: "registerDns",
    group: "dns",
    title: "DNS neu registrieren",
    steps: [REGISTER],
    description: "Erneuert die DHCP-Leases und registriert den Computernamen neu im DNS.",
    admin: true,
    danger: false,
    adapter: "none",
    changesIp: false,
    reboot: false,
    success: "DNS-Registrierung gestartet",
  },
  {
    id: "dnsRefresh",
    group: "dns",
    title: "DNS komplett auffrischen",
    steps: [FLUSH, REGISTER],
    description: "DNS-Cache leeren und danach den Computernamen neu im DNS registrieren.",
    admin: true,
    danger: false,
    adapter: "none",
    changesIp: false,
    reboot: false,
    success: "DNS aufgefrischt: Cache geleert, Registrierung gestartet",
  },
  // ---- Cache & Namen ------------------------------------------------------
  {
    id: "arpClear",
    group: "cache",
    title: "ARP-Cache leeren",
    steps: [{ short: "arp", cmd: "arp -d *" }],
    description: "Löscht die gelernten IP→MAC-Zuordnungen, z. B. nach Gerätetausch. Ansehen: Tabellen (F4).",
    admin: true,
    danger: false,
    adapter: "none",
    changesIp: false,
    reboot: false,
    success: "ARP-Cache geleert",
  },
  {
    id: "nbtPurge",
    group: "cache",
    title: "NetBIOS-Cache neu laden",
    steps: [{ short: "nbtstat", cmd: "nbtstat -R" }],
    description: "Leert den NetBIOS-Namencache und lädt die Einträge aus der LMHOSTS-Datei neu.",
    admin: true,
    danger: false,
    adapter: "none",
    changesIp: false,
    reboot: false,
    success: "NetBIOS-Cache neu geladen",
  },
  {
    id: "nbtReregister",
    group: "cache",
    title: "NetBIOS neu registrieren",
    steps: [{ short: "nbtstat", cmd: "nbtstat -RR" }],
    description: "Gibt die eigenen NetBIOS-Namen frei und meldet sie neu an (WINS).",
    admin: true,
    danger: false,
    adapter: "none",
    changesIp: false,
    reboot: false,
    success: "NetBIOS-Namen werden neu registriert",
  },
  // ---- Adapter ------------------------------------------------------------
  {
    id: "adapterRestart",
    group: "adapter",
    title: "Adapter neu starten",
    steps: [
      { short: "deaktivieren", cmd: "netsh interface set interface <Adapter> admin=disabled", disruptive: true },
      { short: "warten", waitMs: 3000 },
      { short: "aktivieren", cmd: "netsh interface set interface <Adapter> admin=enabled", restore: true },
    ],
    description: "Deaktiviert den gewählten Adapter, wartet 3 s und aktiviert ihn wieder – wie Kabel ziehen.",
    admin: true,
    danger: true,
    adapter: "required",
    changesIp: true,
    reboot: false,
    success: "Adapter neu gestartet",
    confirm: {
      title: "Adapter neu starten?",
      message:
        "Der Adapter {adapter} wird deaktiviert und nach 3 s wieder aktiviert. Die Verbindung ist so lange weg. " +
        "Wenn du per Fernwartung (RDP) über diesen Adapter verbunden bist, verlierst du die Sitzung.",
      confirmText: "Neu starten",
    },
  },
  // ---- Reparatur ----------------------------------------------------------
  {
    id: "winsockReset",
    group: "repair",
    title: "Winsock zurücksetzen",
    steps: [{ short: "winsock", cmd: "netsh winsock reset" }],
    description: "Setzt den Winsock-Katalog zurück. Hilft, wenn VPN-/Security-Software das Netz kaputt gemacht hat.",
    admin: true,
    danger: true,
    adapter: "none",
    changesIp: false,
    reboot: true,
    success: "Winsock zurückgesetzt – Neustart erforderlich",
    confirm: {
      title: "Winsock zurücksetzen?",
      message:
        "Achtung: Das ändert Netzwerkeinstellungen. Der Winsock-Katalog wird auf Standard gesetzt – " +
        "VPN-Clients oder Sicherheitssoftware müssen danach evtl. neu installiert werden. " +
        "Windows muss danach neu gestartet werden.",
      confirmText: "Zurücksetzen",
    },
  },
  {
    id: "tcpipReset",
    group: "repair",
    title: "TCP/IP zurücksetzen",
    steps: [{ short: "ip reset", cmd: "netsh int ip reset" }],
    description: "Setzt den TCP/IP-Stack auf Standard zurück. Statische IP-Einstellungen können verloren gehen.",
    admin: true,
    danger: true,
    adapter: "none",
    changesIp: false,
    reboot: true,
    success: "TCP/IP zurückgesetzt – Neustart erforderlich",
    confirm: {
      title: "TCP/IP zurücksetzen?",
      message:
        "Achtung: Das ändert Netzwerkeinstellungen. TCP/IP wird auf Werkseinstellung gesetzt – statische IP-Adressen, " +
        "Gateways und DNS-Server können verloren gehen (vorher in der Übersicht notieren). " +
        "Windows muss danach neu gestartet werden.",
      confirmText: "Zurücksetzen",
    },
  },
];

export function actionById(id: ActionId): ActionDef {
  const def = ACTIONS.find((a) => a.id === id);
  if (!def) throw new Error(`Unbekannte Aktion: ${id}`);
  return def;
}
