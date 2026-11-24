// TUI-Bausteine: alles ist Text. Keine Icons, keine Rundungen, keine Effekte.
//
//   panel()     Kasten mit 1px-Linie, Titel sitzt IN der oberen Linie (wie htop)
//   tbutton()   [ Text ]  – Hover/Fokus invertiert die Farben
//   checkbox()  [x] Text / [ ] Text
//   radio()     (*) Text / ( ) Text
//   kvRow()     Label . . . . : Wert   (Punkte-Füller wie bei ipconfig)
//   prompt()    $ befehl █   (Überschrift mit blinkendem Block-Cursor)
import { h, type Child } from "./dom";

export interface Panel {
  el: HTMLElement;
  title: HTMLElement;
  right: HTMLElement;
  body: HTMLElement;
}

/** Eckiges Panel. `title` links und `right` rechts sitzen in der oberen Linie. */
export function panel(title: Child, opts: { cls?: string; right?: Child[] } = {}, ...children: Child[]): Panel {
  const titleEl = h("div", { class: "panel-title" }, title);
  const right = h("div", { class: "panel-right" }, ...(opts.right ?? []));
  const body = h("div", { class: "panel-body" }, ...children);
  const el = h("section", { class: `panel ${opts.cls ?? ""}` }, titleEl, right, body);
  return { el, title: titleEl, right, body };
}

/** Button im Terminal-Stil: "[ Text ]". Klammern kommen per CSS dazu. */
export function tbutton(label: string, opts: { onclick?: () => void; title?: string; cls?: string } = {}): HTMLButtonElement {
  return h(
    "button",
    { class: `tbtn ${opts.cls ?? ""}`, type: "button", title: opts.title, onclick: opts.onclick },
    label,
  );
}

/** Checkbox als Text: "[x] Label". */
export function checkbox(label: string, checked: boolean, onchange: (v: boolean) => void): HTMLButtonElement {
  const mark = h("span", { class: "mark" });
  const el = h("button", { class: "tcheck", type: "button", role: "checkbox" }, mark, " ", label);
  const set = (v: boolean) => {
    el.setAttribute("aria-checked", String(v));
    mark.textContent = v ? "[x]" : "[ ]";
  };
  set(checked);
  el.addEventListener("click", () => {
    const v = el.getAttribute("aria-checked") !== "true";
    set(v);
    onchange(v);
  });
  return el;
}

/** Radio-Gruppe als Text: "(*) A  ( ) B". */
export function radio<T extends string>(
  options: { value: T; label: string; title?: string }[],
  value: T,
  onchange: (v: T) => void,
): HTMLElement {
  const group = h("span", { class: "tradio", role: "radiogroup" });
  const buttons = options.map((o) => {
    const mark = h("span", { class: "mark" });
    const b = h("button", { class: "tcheck", type: "button", role: "radio", title: o.title }, mark, " ", o.label);
    b.addEventListener("click", () => {
      select(o.value);
      onchange(o.value);
    });
    return { b, mark, value: o.value };
  });
  const select = (v: T) => {
    for (const x of buttons) {
      x.b.setAttribute("aria-checked", String(x.value === v));
      x.mark.textContent = x.value === v ? "(*)" : "( )";
    }
  };
  select(value);
  group.append(...buttons.map((x) => x.b));
  return group;
}

/** Ausgerichtete Zeile "Label . . . . : Wert". Mehrere Werte stehen untereinander. */
export function kvRow(label: string, ...values: Child[]): HTMLElement {
  return h(
    "div",
    { class: "kv-row" },
    h("span", { class: "kv-label" }, h("span", {}, label), h("span", { class: "kv-dots", "aria-hidden": "true" })),
    h("span", { class: "kv-sep" }, ":"),
    h("span", { class: "kv-values" }, ...values),
  );
}

/** Überschrift im Prompt-Stil: "$ ipconfig /all █". `cmd` lässt sich später ändern. */
export function prompt(cmd: string): { el: HTMLElement; set(cmd: string): void } {
  const text = h("span", { class: "prompt-cmd" }, cmd);
  const el = h(
    "h1",
    { class: "prompt" },
    h("span", { class: "prompt-sign" }, "$ "),
    text,
    h("span", { class: "cursor", "aria-hidden": "true" }, "█"),
  );
  return { el, set: (c: string) => (text.textContent = c) };
}

/** Text in Statusfarbe (nur Wörter, nie Punkte/Linien): ok = grün, err = rot. */
export function tag(text: string, kind: "ok" | "err" | "dim" | "plain" = "plain"): HTMLSpanElement {
  return h("span", { class: `tag tag-${kind}` }, text);
}
