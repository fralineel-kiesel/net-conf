// Mini-Helfer zum Erzeugen von DOM-Elementen – ersetzt ein Framework.
//   h("button", { class: "btn", onclick: () => … }, "Text")

type Child = Node | string | number | null | undefined | false;
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

// Linien-Icons (24×24, Strich = currentColor). Statischer, eigener Inhalt –
// daher ist innerHTML hier unbedenklich.
const ICONS = {
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/>',
  chevron: '<path d="M6 15l6-6 6 6"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  play: '<path d="M7 4l13 8-13 8z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  unplug: '<path d="M9 2v5M15 2v5"/><path d="M6 7h12v4a6 6 0 0 1-12 0z"/><path d="M12 17v5"/><path d="M3 3l18 18"/>',
  eraser: '<path d="M7 21h13"/><path d="M5.5 15.5l9-9a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L13 18H8z"/>',
  upload: '<path d="M12 20V9"/><path d="M7 13l5-5 5 5"/><path d="M5 4h14"/>',
  terminal: '<path d="M4 17l6-5-6-5"/><path d="M12 19h8"/>',
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, cls = "icon"): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = cls;
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
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
