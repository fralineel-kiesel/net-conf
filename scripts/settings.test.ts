// Tests der Einstellungs-Prüfung und von Export/Import (ohne Test-Framework): npm test
import { DEFAULTS, exportSettings, importSettings, sanitizeSettings } from "../src/settingsdata.ts";

const eq = (a: unknown, b: unknown, msg: string) => {
  const A = JSON.stringify(a);
  const B = JSON.stringify(b);
  if (A !== B) { console.log("FAIL", msg, A, "!=", B); process.exitCode = 1; }
  else console.log("ok  ", msg);
};

// --- Laden: Ungültiges → Standard ----------------------------------------------------
eq(sanitizeSettings({}), DEFAULTS, "leer → Standardwerte");
eq(sanitizeSettings(null), DEFAULTS, "null → Standardwerte");
eq(sanitizeSettings("Unsinn"), DEFAULTS, "Text → Standardwerte");
const bad = sanitizeSettings({
  theme: "hacker",
  accent: "#ff0000", // Rot ist für Status reserviert
  font: "comic-sans",
  fontSize: 99,
  pingTarget: "1.1.1.1 & calc",
  pingCount: 7,
  consoleLines: 3,
  startView: "admin",
  statusClock: "ja",
  keybindings: [{ combo: "Strg+C", command: "x" }],
  unbekannt: true,
});
eq(bad, DEFAULTS, "alle ungültigen Werte werden zum Standard, Unbekanntes fällt weg");
const good = sanitizeSettings({
  theme: "retro",
  font: "vt323",
  fontSize: 15,
  pingCount: "inf",
  consoleTimestamps: true,
  statusClock: true,
  cursorBlink: false,
  monitorAutostart: true,
  startView: "tools",
  keybindings: [{ combo: "Alt+H", command: "test.health" }],
});
eq([good.theme, good.font, good.fontSize, good.pingCount, good.consoleTimestamps, good.statusClock, good.cursorBlink, good.monitorAutostart, good.startView],
  ["retro", "vt323", 15, "inf", true, true, false, true, "tools"], "gültige Werte bleiben");
eq(good.keybindings, [{ combo: "Alt+H", command: "test.health" }], "Tastenkürzel bleiben");
eq(sanitizeSettings({ pingTarget: "  example.com " }).pingTarget, "example.com", "Ping-Ziel wird getrimmt");

// --- Export → Import (Rundreise) --------------------------------------------------------
const text = exportSettings(good, "0.6.0");
const back = importSettings(text);
eq("settings" in back ? back.settings : back, good, "Export und Import ergeben dieselben Einstellungen");
eq("settings" in back ? back.ignored : back, [], "nichts ignoriert");
eq(JSON.parse(text).kind, "net-conf-settings", "Export ist erkennbar");

// --- Import: Fehlerfälle -----------------------------------------------------------------
eq("error" in importSettings("hallo"), true, "kein JSON");
eq("error" in importSettings(JSON.stringify({ theme: "retro" })), true, "fremdes JSON ohne Kennung");
eq("error" in importSettings(JSON.stringify({ kind: "net-conf-settings", format: 99, settings: {} })), true, "unbekanntes Format");
eq("error" in importSettings(JSON.stringify({ kind: "net-conf-settings", format: 1 })), true, "ohne Einstellungen");
eq("error" in importSettings("x".repeat(200_000)), true, "zu lang");
const partial = importSettings(JSON.stringify({ kind: "net-conf-settings", format: 1, settings: { theme: "sepia", fontSize: 50, hack: 1 } }));
eq("settings" in partial ? [partial.settings.theme, partial.settings.fontSize] : partial, ["sepia", 13], "teilweise gültig: Gültiges übernommen");
eq("settings" in partial ? partial.ignored : partial, ["fontSize", "hack"], "Ungültiges wird gemeldet");
