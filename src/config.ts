// Gespeicherte Daten aus config.json (%APPDATA%\Net-Conf, siehe config.rs):
// Monitor-Ziele und WoL-Geräte. Das Frontend hält eine Kopie; jede Änderung
// geht ans Backend, das prüft, normalisiert (z. B. MAC "AA-BB-…") und atomar speichert.
import { backend, errorText } from "./api";
import type { AppConfig } from "./types";

let current: AppConfig = { version: 1, monitorTargets: [], monitorIntervalSec: 2, wolDevices: [] };
let path = "";
const listeners = new Set<() => void>();

export function config(): AppConfig {
  return current;
}

export function configPath(): string {
  return path;
}

export function onConfigChange(fn: () => void): void {
  listeners.add(fn);
}

const notify = () => listeners.forEach((fn) => fn());

/** Beim Start laden. Gibt einen Hinweis zurück (z. B. kaputte Datei) oder null. */
export async function loadConfig(): Promise<string | null> {
  try {
    const r = await backend.loadConfig();
    current = r.config;
    path = r.path;
    notify();
    return r.notice;
  } catch (err) {
    return `Einstellungen konnten nicht geladen werden: ${errorText(err)}`;
  }
}

/** Ändern + speichern. Wirft eine verständliche Meldung, wenn das Backend ablehnt. */
export async function updateConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
  const saved = await backend.saveConfig({ ...current, ...patch });
  current = saved;
  notify();
  return saved;
}
