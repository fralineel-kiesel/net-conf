// Update-Hinweis: steuert die Prüfung (beim Start höchstens 1× pro 24 h oder
// auf Klick) und zeigt "[UPDATE v0.x.y]" in der Statusleiste.
// Die reine Logik (SemVer, URL-Prüfung, API-Antwort) steht in src/update.ts.
import { backend, errorText } from "../api";
import { settings } from "../settings";
import { isNewer, isReleaseUrl, releaseErrorText } from "../update";
import { prefs } from "./dom";
import { setUpdateIndicator, status } from "./statusbar";

const DAY_MS = 24 * 60 * 60 * 1000;
const KEY_LAST = "updateLastCheck";
const KEY_FOUND = "updateFound";

interface Found {
  version: string;
  url: string;
}

/** Zuletzt gefundene neuere Version (bleibt bis zum nächsten Check gespeichert) */
function loadFound(): Found | null {
  try {
    const f = JSON.parse(prefs.get(KEY_FOUND, "null")) as Found | null;
    if (f && typeof f.version === "string" && typeof f.url === "string" && isReleaseUrl(f.url) && isNewer(f.version, __APP_VERSION__)) return f;
  } catch {
    /* kaputt → ignorieren */
  }
  return null;
}

function show(found: Found | null): void {
  setUpdateIndicator(found ? { text: `[UPDATE v${found.version}]`, onclick: () => void openRelease(found.url) } : null);
}

async function openRelease(url: string): Promise<void> {
  try {
    await backend.openReleasePage(url);
    status(`Release-Seite geöffnet: ${url}`, "ok");
  } catch (e) {
    status(errorText(e), "error");
  }
}

/** Zeitpunkt der letzten Prüfung (ms) oder 0 */
export function lastCheck(): number {
  const n = Number(prefs.get(KEY_LAST, "0"));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Jetzt prüfen. `manual = true`: Ergebnis/Fehler als Meldung (Einstellungen).
 * Automatisch: Fehler (offline, Limit, privates Repo) werden still ignoriert.
 */
export async function checkForUpdates(manual: boolean): Promise<{ text: string; ok: boolean }> {
  const r = await backend.latestRelease();
  if (r.kind === "error") {
    return { text: releaseErrorText(r.reason), ok: false };
  }
  prefs.set(KEY_LAST, String(Date.now()));
  if (isNewer(r.version, __APP_VERSION__)) {
    const found = { version: r.version, url: r.url };
    prefs.set(KEY_FOUND, JSON.stringify(found));
    show(found);
    const text = `Neue Version v${r.version} verfügbar – Klick auf [UPDATE v${r.version}] unten öffnet die Release-Seite.`;
    if (!manual) status(`Update verfügbar: v${r.version}`, "ok");
    return { text, ok: true };
  }
  prefs.set(KEY_FOUND, "null");
  show(null);
  return { text: `Net-Conf ist aktuell (v${__APP_VERSION__}, neueste: v${r.version}).`, ok: true };
}

/** Beim Start: gemerkten Hinweis zeigen und ggf. still prüfen (max. 1× pro 24 h). */
export function initUpdates(): void {
  show(loadFound());
  if (!settings.updateCheck) return;
  const last = lastCheck();
  if (Date.now() - last < DAY_MS && last <= Date.now()) return;
  void checkForUpdates(false).catch(() => {
    /* automatischer Check: Fehler still ignorieren */
  });
}
