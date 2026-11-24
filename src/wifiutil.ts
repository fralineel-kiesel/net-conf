// Reine Helfer für die WLAN-Seite – ohne DOM und ohne Tauri, damit sie in den
// Node-Tests laufen (npm test). Verbindlich prüft immer das Backend (wifiprofile.rs).
import type { WifiBss, WifiNetwork, WifiSecurity } from "./types";

/** Hinweis, wenn die Netzliste leer ist oder SSIDs fehlen (gleicher Text wie wifi.rs) */
export const NAMES_HIDDEN_HINT =
  "Windows blendet WLAN-Namen aus, wenn die Standortdienste aus sind: Einstellungen > Datenschutz & Sicherheit > Standort.";

/** Textbalken für das Signal: [#####-----] */
export function hashBarText(fraction: number, width = 10): string {
  const f = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const full = Math.round(f * width);
  return `[${"#".repeat(full)}${"-".repeat(width - full)}]`;
}

/** Anzeige der SSID – versteckte Netze als <versteckt> */
export const ssidLabel = (n: { ssid: string }) => (n.ssid ? n.ssid : "<versteckt>");

/** Band-Reihenfolge für die Kanal-Belegung */
export const BANDS = ["2,4 GHz", "5 GHz", "6 GHz"] as const;

export interface ChannelRow {
  channel: number;
  /** Anzahl Access Points auf diesem Kanal */
  aps: number;
  /** verschiedene SSIDs (versteckte als <versteckt>) */
  networks: string[];
  /** eigener Kanal (aktuelle Verbindung) */
  own: boolean;
}

/**
 * Kanal-Belegung pro Band. 2,4 GHz: immer Kanal 1–13 (14 nur wenn belegt),
 * 5/6 GHz: nur belegte Kanäle (plus der eigene).
 */
export function channelUsage(
  bss: WifiBss[],
  own: { channel: number | null; band: string | null } | null,
): { band: string; rows: ChannelRow[] }[] {
  const result: { band: string; rows: ChannelRow[] }[] = [];
  for (const band of BANDS) {
    const map = new Map<number, ChannelRow>();
    const get = (ch: number) => {
      let r = map.get(ch);
      if (!r) {
        r = { channel: ch, aps: 0, networks: [], own: false };
        map.set(ch, r);
      }
      return r;
    };
    if (band === "2,4 GHz") for (let ch = 1; ch <= 13; ch++) get(ch);
    for (const b of bss) {
      if (b.band !== band || b.channel === null) continue;
      const r = get(b.channel);
      r.aps++;
      const name = ssidLabel(b);
      if (!r.networks.includes(name)) r.networks.push(name);
    }
    if (own?.channel != null && own.band === band) get(own.channel).own = true;
    const rows = [...map.values()].sort((a, b) => a.channel - b.channel);
    if (band !== "2,4 GHz" && rows.length === 0) continue;
    result.push({ band, rows });
  }
  return result;
}

/** Sicherheit für das Verbinden-Formular (lesbar) */
export function securityLabel(s: WifiSecurity): string {
  return s === "open" ? "Offen (unverschlüsselt)" : s === "wpa2" ? "WPA2-Personal (AES)" : "WPA3-Personal (SAE)";
}

/**
 * Passwort grob prüfen (nur Komfort, gleiche Regeln wie wifiprofile.rs).
 * Gibt eine Meldung zurück oder null. Die Meldung enthält nie das Passwort.
 */
export function passwordProblem(security: WifiSecurity, password: string): string | null {
  if (security === "open") return password ? "Ein offenes Netz hat kein Passwort – das Feld bitte leer lassen." : null;
  if (security === "wpa2" && /^[0-9a-fA-F]{64}$/.test(password)) return null;
  if (!/^[\x20-\x7e]*$/.test(password)) {
    return "Das WLAN-Passwort darf nur Zeichen ohne Umlaute/Sonderzeichen ausserhalb von ASCII enthalten.";
  }
  if (password.length < 8 || password.length > 63) {
    return security === "wpa2"
      ? "Das WLAN-Passwort muss 8–63 Zeichen lang sein (oder genau 64 Hex-Zeichen)."
      : "Das WLAN-Passwort muss 8–63 Zeichen lang sein.";
  }
  return null;
}

/** SSID grob prüfen (max. 32 Byte, keine Steuerzeichen) */
export function ssidProblem(ssid: string): string | null {
  if (!ssid) return "Bitte eine SSID (WLAN-Namen) eingeben.";
  if (new TextEncoder().encode(ssid).length > 32) return "Die SSID ist zu lang (max. 32 Byte, Umlaute zählen doppelt).";
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(ssid)) return "Die SSID enthält Steuerzeichen.";
  return null;
}

/** Netz für das Formular: kann Net-Conf damit verbinden? */
export function connectBlocked(n: WifiNetwork): string | null {
  if (n.connectAs) return null;
  if (n.security === "802.1X") return "[802.1X] nicht unterstützt, bitte über Windows verbinden.";
  if (n.security === "WEP" || n.security === "WPA") {
    return `${n.security} ist veraltet und unsicher – Net-Conf verbindet damit nicht. Bitte über Windows verbinden.`;
  }
  return "Diese Sicherheitsart wird nicht unterstützt, bitte über Windows verbinden.";
}
