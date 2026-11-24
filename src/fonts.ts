// Eingebettete Schriften laden – erst, wenn sie gebraucht werden (Theme/Auswahl
// oder Vorschau in den Einstellungen). Die Dateien liegen in der App (Vite kopiert
// sie nach dist/assets), es wird nie etwas aus dem Internet geholt.
// Daten der Schriften (Name, Stapel, Skalierung) stehen in themes.ts.
import jetbrains from "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2?url";
import plex from "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2?url";
import space from "@fontsource/space-mono/files/space-mono-latin-400-normal.woff2?url";
import vt323 from "@fontsource/vt323/files/vt323-latin-400-normal.woff2?url";
import sharetech from "@fontsource/share-tech-mono/files/share-tech-mono-latin-400-normal.woff2?url";
import { fontById, type FontId } from "./themes";

const URLS: Partial<Record<FontId, string>> = { jetbrains, plex, space, vt323, sharetech };

const requested = new Set<FontId>();
let epoch = 0;
const listeners = new Set<() => void>();

/** Zählt hoch, sobald eine Schrift fertig geladen ist – Graphen messen dann neu. */
export function fontEpoch(): number {
  return epoch;
}

/** Wird aufgerufen, wenn eine eingebettete Schrift fertig geladen ist. */
export function onFontLoaded(fn: () => void): void {
  listeners.add(fn);
}

/** Schrift bereitstellen (eingebettete einmalig laden, Windows-Schriften sind schon da). */
export function ensureFont(id: FontId): void {
  const def = fontById(id);
  const url = URLS[id];
  if (def.source !== "embedded" || !def.face || !url || requested.has(id)) return;
  if (typeof FontFace === "undefined") return;
  requested.add(id);
  const face = new FontFace(def.face, `url(${url}) format("woff2")`, { weight: "400", style: "normal", display: "swap" });
  document.fonts.add(face);
  face
    .load()
    .then(() => {
      epoch++;
      for (const fn of listeners) fn();
    })
    .catch(() => {
      // Datei fehlt/kaputt: der Stapel fällt automatisch auf Cascadia Mono / Consolas zurück
      requested.delete(id);
    });
}
