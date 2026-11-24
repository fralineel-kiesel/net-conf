// Mini-Helfer zum Erzeugen von DOM-Elementen – ersetzt ein Framework.
//   h("button", { class: "btn", onclick: () => … }, "Text")
import logoSvg from "../../assets/logo.svg?raw";

export type Child = Node | string | number | null | undefined | false;
type Props = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.className = String(value);
    else if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2), value as EventListener);
    } else if (value === true) el.setAttribute(key, "");
    else el.setAttribute(key, String(value));
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
}

/** Inhalt eines Elements komplett ersetzen. */
export function replaceChildren(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  append(el, children);
}

/** Das App-Logo (assets/logo.svg) als Inline-SVG – eine Quelle für alles. */
export function logo(): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "logo";
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = logoSvg; // eigene, statische Datei – unbedenklich
  return span;
}

/** Text in die Zwischenablage kopieren (mit Fallback für ältere Umgebungen). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h("textarea", { class: "sr-only" });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

const dateFmt = new Intl.DateTimeFormat("de-CH", { dateStyle: "medium", timeStyle: "short" });

/** Unix-Sekunden → "24.11.2026, 08:12" */
export function formatUnix(seconds: number | null): string {
  return seconds ? dateFmt.format(new Date(seconds * 1000)) : "";
}

/** localStorage kann blockiert sein – daher immer mit try/catch. */
export const prefs = {
  get(key: string, fallback: string): string {
    try {
      return localStorage.getItem(`netconf.${key}`) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(`netconf.${key}`, value);
    } catch {
      /* egal */
    }
  },
};
