// Tests des Update-Hinweises (SemVer, URL-Prüfung, API-Antwort): npm test
import { compareVersions, interpretRelease, isNewer, isReleaseUrl, parseVersion, RELEASES_URL } from "../src/update.ts";

const eq = (a: unknown, b: unknown, msg: string) => {
  const A = JSON.stringify(a);
  const B = JSON.stringify(b);
  if (A !== B) { console.log("FAIL", msg, A, "!=", B); process.exitCode = 1; }
  else console.log("ok  ", msg);
};
const cmp = (a: string, b: string) => Math.sign(compareVersions(parseVersion(a)!, parseVersion(b)!));

eq(parseVersion("v0.6.0"), { major: 0, minor: 6, patch: 0, pre: [] }, "v-Präfix");
eq(parseVersion("1.2.3-beta.2+build.7"), { major: 1, minor: 2, patch: 3, pre: ["beta", "2"] }, "Vorabversion + Build");
eq(parseVersion("1.2"), null, "unvollständig");
eq(parseVersion("v1.2.3 & calc"), null, "Müll abgelehnt");

eq(cmp("0.6.0", "0.5.9"), 1, "0.6.0 > 0.5.9");
eq(cmp("0.10.0", "0.9.0"), 1, "numerisch, nicht alphabetisch (0.10 > 0.9)");
eq(cmp("1.0.0", "1.0.0"), 0, "gleich");
eq(cmp("1.0.0", "1.0.0-rc.1"), 1, "final > Vorabversion");
eq(cmp("1.0.0-rc.2", "1.0.0-rc.10"), -1, "rc.2 < rc.10");
eq(cmp("1.0.0-alpha", "1.0.0-beta"), -1, "alpha < beta");
eq(cmp("1.0.0-rc", "1.0.0-rc.1"), -1, "weniger Teile = älter");
eq(cmp("1.0.0-1", "1.0.0-alpha"), -1, "Zahl vor Text");
eq(isNewer("v0.7.0", "0.6.0"), true, "isNewer");
eq(isNewer("v0.6.0", "0.6.0"), false, "gleiche Version ist kein Update");
eq(isNewer("kaputt", "0.6.0"), false, "ungültig ist kein Update");

eq(isReleaseUrl(`${RELEASES_URL}/tag/v0.7.0`), true, "Release-Seite erlaubt");
eq(isReleaseUrl(`${RELEASES_URL}`), true, "Übersicht erlaubt");
eq(isReleaseUrl(`${RELEASES_URL}/../../evil`), false, "kein ..");
eq(isReleaseUrl(`${RELEASES_URL}?x=1`), false, "kein Query");
eq(isReleaseUrl("https://github.com/someone/else/releases"), false, "fremdes Repo");
eq(isReleaseUrl("https://evil.example/releases"), false, "fremder Host");

eq(interpretRelease(200, { tag_name: "v0.7.0", html_url: `${RELEASES_URL}/tag/v0.7.0` }), { kind: "ok", version: "0.7.0", url: `${RELEASES_URL}/tag/v0.7.0` }, "gültige Antwort");
eq(interpretRelease(200, { tag_name: "v0.7.0", html_url: "https://evil.example/x" }), { kind: "ok", version: "0.7.0", url: `${RELEASES_URL}/latest` }, "fremder Link wird ersetzt");
eq(interpretRelease(404, {}), { kind: "error", reason: "notfound" }, "404 = privat/nicht erreichbar");
eq(interpretRelease(403, {}), { kind: "error", reason: "ratelimit" }, "403 = Limit");
eq(interpretRelease(200, { tag_name: "nightly" }), { kind: "error", reason: "invalid" }, "Tag ohne Version");
eq(interpretRelease(200, null), { kind: "error", reason: "invalid" }, "leere Antwort");
