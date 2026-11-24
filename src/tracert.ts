// Auswertung der tracert.exe-Ausgabe, zeilenweise und sprachunabhängig.
//
// Eine Hop-Zeile sieht in jeder Sprache so aus:
//   "  1    <1 ms    <1 ms    <1 ms  fritz.box [192.168.1.1]"
//   "  3     *        *        *     Zeitüberschreitung der Anforderung."
// Also: Nummer, drei Zeiten ("<1 ms", "12 ms" oder "*"), dann Host oder Text.
// Kopf- und Schlusszeilen ("Routenverfolgung zu …") beginnen nicht mit einer
// Zahl und werden ignoriert.

export interface Hop {
  hop: number;
  /** drei Messungen in ms, null = keine Antwort ("*") */
  rtts: (number | null)[];
  ip: string | null;
  name: string | null;
  /** Rest der Zeile (z. B. "192.168.1.1 meldet: Zielnetz nicht erreichbar.") */
  rest: string;
}

const RTT = String.raw`(\*|<?\s*\d+\s*ms)`;
const HOP_RE = new RegExp(String.raw`^\s*(\d+)\s+${RTT}\s+${RTT}\s+${RTT}\s*(.*)$`, "i");
const IP_RE = /^(\d{1,3}(\.\d{1,3}){3}|[0-9a-f]*:[0-9a-f:.%]+)$/i;

export function parseHop(line: string): Hop | null {
  const m = HOP_RE.exec(line);
  if (!m) return null;
  const rtts = [m[2], m[3], m[4]].map((t) => {
    if (t.trim() === "*") return null;
    if (t.includes("<")) return 0; // "<1 ms" zählt wie bei Windows als 0
    return Number(t.replace(/\D/g, ""));
  });
  const rest = m[5].trim();
  let ip: string | null = null;
  let name: string | null = null;
  const bracket = /^(\S+)\s+\[([0-9a-fA-F:.%]+)\]/.exec(rest); // "name [ip]"
  if (bracket) {
    name = bracket[1];
    ip = bracket[2];
  } else {
    const first = rest.split(/\s+/)[0] ?? "";
    if (IP_RE.test(first)) ip = first;
  }
  return { hop: Number(m[1]), rtts, ip, name, rest };
}

/** Durchschnitt der beantworteten Messungen oder null. */
export function hopAvg(h: Hop): number | null {
  const ok = h.rtts.filter((r): r is number => r !== null);
  return ok.length ? Math.round(ok.reduce((a, b) => a + b, 0) / ok.length) : null;
}
