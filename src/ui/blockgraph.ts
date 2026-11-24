// Latenz-Graph aus Blockzeichen (▁▂▃▄▅▆▇█), mehrzeilig wie bei btop.
//
// Jede Spalte ist ein Messwert. Mit `rows` Zeilen à 8 Stufen ergeben sich
// rows*8 Höhenstufen. Skaliert wird auf min..max der sichtbaren Werte:
// der kleinste Wert bekommt Stufe 1 (sichtbar), der grösste die volle Höhe.
// Verlorene Pakete (null) werden in der untersten Zeile als "×" markiert.

const BLOCKS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export interface GraphCell {
  ch: string;
  lost: boolean;
}

export function blockGraph(values: (number | null)[], rows: number): GraphCell[][] {
  const valid = values.filter((v): v is number => v !== null);
  const lo = valid.length ? Math.min(...valid) : 0;
  const hi = valid.length ? Math.max(...valid) : 0;
  const levels = rows * 8;

  const levelOf = (v: number) =>
    hi === lo ? Math.round(levels / 2) : 1 + Math.round(((v - lo) / (hi - lo)) * (levels - 1));

  const grid: GraphCell[][] = [];
  for (let r = 0; r < rows; r++) {
    const floor = (rows - 1 - r) * 8; // Stufen unterhalb dieser Zeile
    grid.push(
      values.map((v) => {
        if (v === null) return { ch: r === rows - 1 ? "×" : " ", lost: true };
        const fill = Math.max(0, Math.min(8, levelOf(v) - floor));
        return { ch: BLOCKS[fill], lost: false };
      }),
    );
  }
  return grid;
}
