// Globaler App-Zustand – bewusst simpel: ein Objekt + Änderungs-Listener.
import { backend } from "./api";
import { primaryOf } from "./netutil";
import { prefs } from "./ui/dom";
import type { AdapterInfo, WifiInfo } from "./types";

export interface AppState {
  adapters: AdapterInfo[];
  isAdmin: boolean;
  hostname: string;
  loading: boolean;
  /** true, solange ein Befehl aus "Aktionen" läuft */
  busy: boolean;
  error: string | null;
  /** WLAN-Details, über die Interface-GUID den Adaptern zugeordnet */
  wifi: WifiInfo[];
  /** Schalter "Getrennte Adapter ausblenden" (wird gespeichert) */
  hideDisconnected: boolean;
}

export const state: AppState = {
  adapters: [],
  isAdmin: false,
  hostname: "",
  loading: true,
  busy: false,
  error: null,
  wifi: [],
  hideDisconnected: prefs.get("hideDisconnected", "1") === "1",
};

const listeners = new Set<() => void>();

export function onStateChange(fn: () => void): void {
  listeners.add(fn);
}

export function setState(patch: Partial<AppState>): void {
  Object.assign(state, patch);
  for (const fn of listeners) fn();
}

/** Adapter, Hostname und Admin-Status (neu) laden. */
export async function refreshAll(): Promise<void> {
  setState({ loading: true });
  try {
    const [adapters, isAdmin, hostname, wifi] = await Promise.all([
      backend.getAdapters(),
      backend.isAdmin(),
      backend.getHostname(),
      // WLAN-Fehler sollen die Übersicht nicht blockieren
      backend.getWifi().catch(() => [] as WifiInfo[]),
    ]);
    setState({ adapters, isAdmin, hostname, wifi, loading: false, error: null });
  } catch (err) {
    setState({ loading: false, error: String(err) });
  }
}

const byName = (x: AdapterInfo, y: AdapterInfo) =>
  x.name.localeCompare(y.name, "de", { sensitivity: "base" }) || x.id.localeCompare(y.id);

/**
 * Primärer Adapter = verbunden und mit Standardgateway (IPv4 bevorzugt).
 * Gibt es mehrere, entscheidet der Name – so ist das Ergebnis bei jedem
 * Neuladen gleich (die echte Routen-Metrik kennt die Adapterliste nicht).
 */
export function primaryAdapter(): AdapterInfo | undefined {
  return primaryOf(state.adapters);
}

/**
 * Reihenfolge der Adapter-Panels: primärer Adapter zuerst, dann weitere mit
 * Gateway, dann verbundene ohne Gateway, dann getrennte – jeweils nach Name.
 * Hängt nicht von der Reihenfolge ab, die Windows liefert → stabil.
 */
export function sortedAdapters(list: AdapterInfo[]): AdapterInfo[] {
  const primary = primaryAdapter();
  const rank = (a: AdapterInfo) => (a.id === primary?.id ? 0 : a.gateways.length > 0 ? 1 : a.connected ? 2 : 3);
  return [...list].sort((x, y) => rank(x) - rank(y) || byName(x, y));
}

/** WLAN-Infos zu einem Adapter (Vergleich der GUID ohne Gross/Klein). */
export function wifiFor(adapter: AdapterInfo): WifiInfo | undefined {
  const id = adapter.id.toUpperCase();
  return state.wifi.find((w) => w.interfaceId.toUpperCase() === id);
}
