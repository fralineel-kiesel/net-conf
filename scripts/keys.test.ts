// Tests der eigenen Tastenkürzel (ohne Test-Framework): npm test
import { checkCombo, comboFromEvent, findConflict, sanitizeBindings, type KeyLike } from "../src/keys.ts";

const eq = (a: unknown, b: unknown, msg: string) => {
  const A = JSON.stringify(a);
  const B = JSON.stringify(b);
  if (A !== B) { console.log("FAIL", msg, A, "!=", B); process.exitCode = 1; }
  else console.log("ok  ", msg);
};
const ev = (key: string, mods: Partial<KeyLike> = {}, code?: string): KeyLike => ({
  key, code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods,
});

// --- Tastendruck → Text -----------------------------------------------------------
eq(comboFromEvent(ev("d", { ctrlKey: true, shiftKey: true }, "KeyD")), "Strg+Umschalt+D", "Strg+Umschalt+D");
eq(comboFromEvent(ev("D", { ctrlKey: true, shiftKey: true }, "KeyD")), "Strg+Umschalt+D", "Grossbuchstabe gleich");
eq(comboFromEvent(ev("z", { altKey: true }, "KeyY")), "Alt+Z", "deutsches Layout: Z bleibt Z (nicht der US-Code)");
eq(comboFromEvent(ev("!", { ctrlKey: true, shiftKey: true }, "Digit1")), "Strg+Umschalt+1", "Umschalt+1 = 1 (nicht !)");
eq(comboFromEvent(ev("1", { altKey: true }, "Numpad1")), "Alt+Num1", "Ziffernblock");
eq(comboFromEvent(ev("F12")), "F12", "F12 ohne Zusatztaste");
eq(comboFromEvent(ev("ArrowUp", { ctrlKey: true })), "Strg+Pfeil↑", "Pfeiltaste mit deutschem Namen");
eq(comboFromEvent(ev("+", { ctrlKey: true })), "Strg+Plus", "Plus-Taste heisst Plus");
eq(comboFromEvent(ev("ö", { ctrlKey: true })), "Strg+Ö", "Umlaut");
eq(comboFromEvent(ev("Control", { ctrlKey: true })), null, "nur Strg = noch keine Kombination");
eq(comboFromEvent(ev("Escape")), null, "Esc geht nicht");
eq(comboFromEvent(ev("Enter", { ctrlKey: true })), null, "Enter geht nicht");
eq(comboFromEvent(ev("e", { metaKey: true })), null, "Windows-Taste geht nicht");

// --- Erlaubt oder nicht? -----------------------------------------------------------
eq(checkCombo("Strg+Umschalt+D"), null, "Strg+Umschalt+D erlaubt");
eq(checkCombo("Alt+P"), null, "Alt+P erlaubt");
eq(checkCombo("F12"), null, "F12 erlaubt");
eq(checkCombo("Umschalt+F11"), null, "Umschalt+F11 erlaubt");
eq(checkCombo("D") !== null, true, "ohne Zusatztaste abgelehnt (stört beim Tippen)");
eq(checkCombo("Umschalt+D") !== null, true, "nur Umschalt abgelehnt");
eq(checkCombo("F7")?.includes("fest vergeben"), true, "F7 = Seitenwechsel");
eq(checkCombo("Strg+K")?.includes("Befehlspalette"), true, "Strg+K = Befehlspalette");
eq(checkCombo("Strg+C")?.includes("Kopieren"), true, "Strg+C = Kopieren");
eq(checkCombo("Strg+Plus") !== null, true, "Strg+Plus = Schriftgrösse");
eq(checkCombo("Strg+Alt+Q")?.includes("AltGr"), true, "Strg+Alt = AltGr abgelehnt");
eq(checkCombo("Umschalt+Strg+D"), "Ungültige Tastenkombination.", "falsche Reihenfolge");
eq(checkCombo("Hyper+D"), "Ungültige Tastenkombination.", "unbekannte Zusatztaste");
eq(checkCombo(""), "Ungültige Tastenkombination.", "leer");

// --- Konflikte und gespeicherte Liste ------------------------------------------------
const list = [{ combo: "Strg+Umschalt+D", command: "action.flushDns" }, { combo: "Alt+P", command: "test.health" }];
eq(findConflict(list, "Alt+P")?.command, "test.health", "Konflikt erkannt");
eq(findConflict(list, "Alt+P", 1), null, "eigener Eintrag zählt beim Bearbeiten nicht");
eq(findConflict(list, "Alt+Q"), null, "frei");
eq(
  sanitizeBindings([
    { combo: "Strg+Umschalt+D", command: "action.flushDns" },
    { combo: "Strg+Umschalt+D", command: "test.health" }, // doppelt
    { combo: "Strg+C", command: "x" }, // reserviert
    { combo: "Alt+X", command: "bad id; rm" }, // komische Befehls-ID
    { combo: 5, command: "y" },
    "Unsinn",
  ]),
  [{ combo: "Strg+Umschalt+D", command: "action.flushDns" }],
  "Ungültiges, Doppeltes und Reserviertes fällt beim Laden weg",
);
eq(sanitizeBindings("kein Array"), [], "kein Array → leer");
eq(sanitizeBindings(Array.from({ length: 80 }, (_, i) => ({ combo: `Alt+${i % 10}${i}`.replace(/(\d)(\d+)$/, "$1"), command: `c${i}` }))).length <= 50, true, "höchstens 50");
