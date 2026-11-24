// Kleine Hinweis-Meldungen ("Kopiert", Fehler, Erfolg) oben rechts.
import { h } from "./dom";

type Kind = "info" | "success" | "error";

let container: HTMLElement | null = null;

export function toast(message: string, kind: Kind = "info", ms?: number): void {
  if (!container) {
    container = h("div", { class: "toasts", role: "status", "aria-live": "polite" });
    document.body.append(container);
  }
  const el = h("div", { class: `toast toast-${kind}` }, message);
  container.append(el);
  // Fehler bleiben länger stehen, damit man sie lesen kann.
  const lifetime = ms ?? (kind === "error" ? 6000 : kind === "success" ? 2500 : 1400);
  setTimeout(() => {
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 160);
  }, lifetime);
  el.addEventListener("click", () => el.remove());
}
