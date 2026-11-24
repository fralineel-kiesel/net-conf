// Globaler App-Zustand – bewusst simpel: ein Objekt + Änderungs-Listener.
import { backend } from "./api";
import type { AdapterInfo } from "./types";

export interface AppState {
  adapters: AdapterInfo[];
  isAdmin: boolean;
  hostname: string;
  loading: boolean;
  /** true, solange ein Befehl aus "Aktionen" läuft */
  busy: boolean;
  error: string | null;
}

export const state: AppState = {
  adapters: [],
  isAdmin: false,
  hostname: "",
  loading: true,
  busy: false,
  error: null,
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
    const [adapters, isAdmin, hostname] = await Promise.all([
      backend.getAdapters(),
      backend.isAdmin(),
      backend.getHostname(),
    ]);
    setState({ adapters, isAdmin, hostname, loading: false, error: null });
  } catch (err) {
    setState({ loading: false, error: String(err) });
  }
}

/** Erster verbundener Adapter mit Gateway – für die Ping-Schnellwahl. */
export function primaryAdapter(): AdapterInfo | undefined {
  return (
    state.adapters.find((a) => a.connected && a.gateways.some((g) => g.includes("."))) ??
    state.adapters.find((a) => a.connected && a.gateways.length > 0)
  );
}
