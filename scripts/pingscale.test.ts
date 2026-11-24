// Test der Ping-Graph-Skala (ohne Test-Framework): npm test
// Braucht Node >= 22 (versteht TypeScript direkt per --experimental-strip-types).
import { LatencyScale, niceScale } from "../src/pingscale.ts";
const eq = (a: unknown, b: unknown, msg: string) => { if (a !== b) { console.log("FAIL", msg, a, "!=", b); process.exitCode = 1; } else console.log("ok  ", msg); };
eq(niceScale(0), 10, "0 ms -> 10"); eq(niceScale(10), 10, "10 -> 10"); eq(niceScale(11), 20, "11 -> 20");
eq(niceScale(499), 500, "499 -> 500"); eq(niceScale(1500), 2000, "1500 -> 2000");
const s = new LatencyScale(); const hist: (number|null)[] = [];
const push = (v: number|null) => { hist.push(v); return s.update(hist.slice(-60)); };
for (const v of [7, 8, 7, 9, 3]) push(v);
eq(s.max, 10, "Werte 1-10 ms -> Skala 10");
eq(push(35), 50, "Spitze 35 ms -> sofort 50");
for (let i = 0; i < 30; i++) push(8);
eq(s.max, 50, "Spitze noch sichtbar -> bleibt 50");
// Spitze aus dem sichtbaren Fenster schieben (60 Werte)
for (let i = 0; i < 29; i++) push(8);
eq(s.max, 50, "Spitze gerade raus, noch keine 10 ruhigen Messungen");
for (let i = 0; i < 9; i++) push(8);
eq(s.max, 50, "nach 9 ruhigen Messungen noch 50");
push(8);
eq(s.max, 10, "nach 10 ruhigen Messungen -> 10");
const t = new LatencyScale(); const h2: (number|null)[] = [];
const p2 = (v: number|null) => { h2.push(v); return t.update(h2.slice(-60)); };
p2(15); eq(t.max, 20, "15 -> 20");
for (let i = 0; i < 80; i++) p2(9);
eq(t.max, 20, "9 ms bei Skala 20: nicht deutlich unter 10 (80 % = 8) -> bleibt 20");
for (let i = 0; i < 80; i++) p2(null);
eq(t.max, 10, "nur Timeouts sichtbar -> schrumpft auf 10");
