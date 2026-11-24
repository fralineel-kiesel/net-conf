// Tests der Fuzzy-Suche (Befehlspalette): npm test
import { fuzzyFilter, fuzzyScore, normalize } from "../src/fuzzy.ts";

const eq = (a: unknown, b: unknown, msg: string) => {
  const A = JSON.stringify(a);
  const B = JSON.stringify(b);
  if (A !== B) { console.log("FAIL", msg, A, "!=", B); process.exitCode = 1; }
  else console.log("ok  ", msg);
};

eq(normalize("Übersicht"), "ubersicht", "Akzente und Grossbuchstaben weg");
eq(fuzzyScore("", "egal"), 0, "leere Eingabe passt immer");
eq(fuzzyScore("xyz", "Gehe zu WLAN"), null, "passt nicht");
eq(fuzzyScore("gzw", "Gehe zu WLAN") !== null, true, "Teilfolge passt");
eq(fuzzyScore("ubersicht", "Gehe zu Übersicht") !== null, true, "ohne Umlaut tippen");
eq(fuzzyScore("wl", "WLAN")! > fuzzyScore("wl", "Gehe zu WLAN")!, true, "Anfang schlägt Wortanfang");
eq(fuzzyScore("wlan", "Gehe zu WLAN")! > fuzzyScore("lan", "Gehe zu WLAN")!, true, "Wortanfang schlägt Wortmitte");
eq(fuzzyScore("lan", "WLAN")! > fuzzyScore("ln", "WLAN")!, true, "Teilstring schlägt Teilfolge");

const items = ["Gehe zu Übersicht", "Gehe zu WLAN", "Gehe zu LAN", "DNS-Cache leeren", "Theme: Amber"];
eq(fuzzyFilter("lan", items, (x) => [x]), ["Gehe zu LAN", "Gehe zu WLAN"], "LAN vor WLAN");
eq(fuzzyFilter("dns", items, (x) => [x])[0], "DNS-Cache leeren", "DNS zuerst");
eq(fuzzyFilter("", items, (x) => [x]), items, "leer: alle in Originalreihenfolge");
eq(fuzzyFilter("bernstein", items, (x) => [x, x === "Theme: Amber" ? "Bernstein" : ""]), ["Theme: Amber"], "Stichwörter werden durchsucht");
eq(fuzzyFilter("dns", ["Theme: Cyan"], (x) => [x, "farbe darstellung aussehen"]), [], "Stichwörter: keine Teilfolgen-Treffer");
