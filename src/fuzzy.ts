// Einfache Fuzzy-Suche für die Befehlspalette – ohne Bibliothek.
//
// Bewertung (höher = besser):
//   1. Text beginnt mit der Eingabe           ("wl"   → "WLAN")
//   2. Eingabe steht am Wortanfang im Text    ("wlan" → "Gehe zu WLAN")
//   3. Eingabe steht irgendwo im Text         ("lan"  → "WLAN")
//   4. Buchstaben kommen der Reihe nach vor   ("gzw"  → "Gehe zu WLAN"), je enger, desto besser
// Gross/klein und Akzente (ä → a) spielen keine Rolle, Leerzeichen in der Eingabe auch nicht.

/** Kleinschreibung, Akzente weg ("Übersicht" → "ubersicht") */
export function normalize(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

const WORD_START = /[\s\-_/(.:[]/;

/** Punktzahl oder null (passt nicht). Leere Eingabe passt immer (0). */
export function fuzzyScore(query: string, text: string): number | null {
  const q = normalize(query).trim();
  const t = normalize(text);
  if (!q) return 0;
  const idx = t.indexOf(q);
  if (idx === 0) return 1000 - t.length;
  if (idx > 0) return (WORD_START.test(t[idx - 1]) ? 800 : 600) - idx - t.length / 10;
  // Teilfolge: jedes Zeichen der Eingabe (ohne Leerzeichen) der Reihe nach suchen
  let score = 400;
  let from = 0;
  let last = -1;
  for (const ch of q.replace(/\s+/g, "")) {
    const found = t.indexOf(ch, from);
    if (found < 0) return null;
    // Lücken kosten Punkte, Treffer am Wortanfang bringen welche
    score -= last < 0 ? found : found - last - 1;
    if (found === 0 || WORD_START.test(t[found - 1])) score += 5;
    last = found;
    from = found + 1;
  }
  return score - t.length / 10;
}

/** Liste filtern und sortieren (beste zuerst). Bei gleicher Punktzahl bleibt die Reihenfolge. */
export function fuzzyFilter<T>(query: string, items: T[], texts: (item: T) => string[]): T[] {
  const scored: { item: T; score: number; i: number }[] = [];
  items.forEach((item, i) => {
    let best: number | null = null;
    texts(item).forEach((text, k) => {
      const s = fuzzyScore(query, text);
      if (s === null) return;
      // Nebentexte (Stichwörter) nur als Teilstring (≥ 600) – Teilfolgen wären dort zu ungenau –
      // und etwas schwächer als der Titel
      if (k === 0) best = Math.max(best ?? -Infinity, s);
      else if (s >= 600) best = Math.max(best ?? -Infinity, s - 50);
    });
    if (best !== null) scored.push({ item, score: best, i });
  });
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).map((x) => x.item);
}
