// Update-Hinweis: fragt die GitHub-Releases-API des eigenen Repos nach der
// neuesten Version. Reine Logik + Abfrage, ohne DOM (getestet in scripts/update.test.ts).
//
// * Abfrage per fetch aus dem WebView – derselbe Weg wie bei der öffentlichen IP
//   (kein HTTP-Crate im Backend). Der Host steht in der CSP (tauri.conf.json).
// * Es wird nichts heruntergeladen oder installiert. Der Klick auf den Hinweis
//   öffnet nur die Release-Seite – das Backend prüft die Adresse noch einmal.
// * Owner/Repo stammen aus dem Git-Remote (github.com/fralineel-kiesel/net-conf)
//   und stehen gleich auch in src-tauri/src/desktop.rs (REPO_OWNER/REPO_NAME).

export const REPO_OWNER = "fralineel-kiesel";
export const REPO_NAME = "net-conf";
export const RELEASES_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases`;
export const LATEST_API = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;

export interface Version {
  major: number;
  minor: number;
  patch: number;
  /** Vorabversion, z. B. ["beta", "2"] bei 1.0.0-beta.2 (leer = finale Version) */
  pre: string[];
}

/** "v0.6.0", "0.6.0", "1.0.0-beta.2+build5" → Version (oder null) */
export function parseVersion(raw: string): Version | null {
  const m = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(raw.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split(".") : [] };
}

/** SemVer-Vergleich: < 0 wenn a älter ist, 0 gleich, > 0 wenn a neuer ist. */
export function compareVersions(a: Version, b: Version): number {
  for (const k of ["major", "minor", "patch"] as const) {
    if (a[k] !== b[k]) return a[k] - b[k];
  }
  // Finale Version ist neuer als jede Vorabversion (1.0.0 > 1.0.0-rc.1)
  if (!a.pre.length || !b.pre.length) return b.pre.length - a.pre.length;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1; // weniger Teile = älter (rc < rc.1)
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny && Number(x) !== Number(y)) return Number(x) - Number(y);
    if (nx !== ny) return nx ? -1 : 1; // Zahlen vor Text
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Ist `latest` neuer als `current`? Ungültige Versionen → false. */
export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  return a !== null && b !== null && compareVersions(a, b) > 0;
}

/** Nur https://github.com/<owner>/<repo>/releases… (gleiche Regel wie is_release_url in desktop.rs) */
export function isReleaseUrl(url: string): boolean {
  if (!url.startsWith(RELEASES_URL) || url.length > 200) return false;
  const rest = url.slice(RELEASES_URL.length);
  return (rest === "" || rest.startsWith("/")) && !rest.includes("..") && /^[A-Za-z0-9\-._/]*$/.test(rest);
}

export type ReleaseCheck =
  | { kind: "ok"; version: string; url: string }
  | { kind: "error"; reason: "notfound" | "ratelimit" | "offline" | "invalid" };

/** Antwort der API auswerten (rein, getestet). */
export function interpretRelease(status: number, body: unknown): ReleaseCheck {
  if (status === 404) return { kind: "error", reason: "notfound" };
  if (status === 403 || status === 429) return { kind: "error", reason: "ratelimit" };
  if (status < 200 || status >= 300 || typeof body !== "object" || body === null) return { kind: "error", reason: "invalid" };
  const b = body as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown };
  const tag = typeof b.tag_name === "string" ? b.tag_name : "";
  const v = parseVersion(tag);
  if (!v || b.draft === true) return { kind: "error", reason: "invalid" };
  const version = `${v.major}.${v.minor}.${v.patch}${v.pre.length ? "-" + v.pre.join(".") : ""}`;
  // Link aus der Antwort nur verwenden, wenn er zum eigenen Repo gehört – sonst selbst bauen
  const url = typeof b.html_url === "string" && isReleaseUrl(b.html_url) ? b.html_url : `${RELEASES_URL}/latest`;
  return { kind: "ok", version, url };
}

/** Verständliche Meldung für die manuelle Prüfung. */
export function releaseErrorText(reason: Extract<ReleaseCheck, { kind: "error" }>["reason"]): string {
  switch (reason) {
    case "notfound":
      return "Prüfung nicht möglich: Repository ist privat oder nicht erreichbar (oder es gibt noch kein Release).";
    case "ratelimit":
      return "Prüfung nicht möglich: GitHub-Abfragelimit erreicht – bitte später erneut versuchen.";
    case "offline":
      return "Prüfung nicht möglich: keine Verbindung zu GitHub (offline oder blockiert).";
    case "invalid":
      return "Prüfung nicht möglich: unerwartete Antwort von GitHub.";
  }
}

/** Neueste Version bei GitHub abfragen (max. 8 s). Wirft nie – Fehler kommen als ReleaseCheck. */
export async function fetchLatestRelease(): Promise<ReleaseCheck> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(LATEST_API, {
      signal: ctrl.signal,
      cache: "no-store",
      headers: { Accept: "application/vnd.github+json" },
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return interpretRelease(res.status, body);
  } catch {
    return { kind: "error", reason: "offline" };
  } finally {
    clearTimeout(timer);
  }
}
