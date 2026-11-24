// TUI-Bausteine: alles ist Text. Keine Icons, keine Rundungen, keine Effekte.
//
//   panel()     Kasten mit 1px-Linie, Titel sitzt IN der oberen Linie (wie htop)
//   tbutton()   [ Text ]  – Hover/Fokus invertiert die Farben
//   checkbox()  [x] Text / [ ] Text
//   radio()     (*) Text / ( ) Text
//   choice()    [2] [4] [8] – Auswahl als Reihe, die gewählte Option invertiert
//   kvRow()     Label . . . . : Wert   (Punkte-Füller wie bei ipconfig)
//   prompt()    $ befehl █   (Überschrift mit blinkendem Block-Cursor)
//   hashBar()   [#####-----] (Signal, Kanal-Belegung)
import { copyText, h, type Child } from "./dom";

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

/** Auswahl als Reihe von Text-Buttons "[2] [4] [8]" – die gewählte Option
 *  ist invertiert (Akzent-Hintergrund), wie eine Markierung im Terminal. */
export function choice<T extends string | number>(
  options: { value: T; label: string; title?: string }[],
  value: T,
  onchange: (v: T) => void,
): { el: HTMLElement; set(v: T): void } {
  const el = h("span", { class: "tchoices", role: "radiogroup" });
  const buttons = options.map((o) => {
    const b = h("button", { class: "tchoice", type: "button", role: "radio", title: o.title }, o.label);
    b.addEventListener("click", () => {
      set(o.value);
      onchange(o.value);
    });
    return { b, value: o.value };
  });
  const set = (v: T) => {
    for (const x of buttons) {
      x.b.classList.toggle("selected", x.value === v);
      x.b.setAttribute("aria-checked", String(x.value === v));
    }
  };
  set(value);
  el.append(...buttons.map((x) => x.b));
  return { el, set };
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

/** Reiter-Leiste: "[Ping]  Traceroute   DNS" – aktiver Reiter in Klammern und Akzentfarbe.
 *  Aktive und inaktive Reiter sind gleich breit, damit beim Wechsel nichts springt. */
export function tabs<T extends string>(
  items: { value: T; label: string }[],
  value: T,
  onchange: (v: T) => void,
): { el: HTMLElement; set(v: T): void } {
  const el = h("div", { class: "ttabs", role: "tablist" });
  const buttons = items.map((it, i) => {
    const b = h("button", { class: "ttab", type: "button", role: "tab" });
    b.addEventListener("click", () => {
      set(it.value);
      onchange(it.value);
    });
    if (i > 0) el.append(" ");
    el.append(b);
    return { b, it };
  });
  const set = (v: T) => {
    for (const { b, it } of buttons) {
      const active = it.value === v;
      b.textContent = active ? `[${it.label}]` : ` ${it.label} `;
      b.classList.toggle("active", active);
      b.setAttribute("aria-selected", String(active));
    }
  };
  set(value);
  return { el, set };
}

export interface Column<R> {
  title: string;
  /** Breite als CSS-Grid-Wert, z. B. "18ch" oder "minmax(0, 1fr)" */
  width: string;
  cell: (row: R) => Child;
  align?: "right";
  /** Klick auf den Spaltenkopf sortiert (der Kopf wird dann zum Text-Button) */
  onSort?: () => void;
  /** Diese Spalte ist gerade die Sortierung: Pfeil ▲/▼ hinter dem Titel */
  sorted?: "asc" | "desc";
}

/** Kopfzelle: Text oder (sortierbar) Button "TITEL ▲" */
function headCell<R>(c: Column<R>): Child {
  const title = c.title.toUpperCase();
  if (!c.onSort) return title;
  const arrow = c.sorted === "asc" ? " ▲" : c.sorted === "desc" ? " ▼" : "";
  return h(
    "button",
    {
      class: `thsort${c.sorted ? " active" : ""}`,
      type: "button",
      title: "Klicken zum Sortieren",
      "aria-sort": c.sorted === "asc" ? "ascending" : c.sorted === "desc" ? "descending" : "none",
      onclick: c.onSort,
    },
    title + arrow,
  );
}

/** Text-Tabelle mit ausgerichteten Spalten (Kopfzeile gedimmt, in GROSSBUCHSTABEN). */
export function table<R>(columns: Column<R>[], rows: R[], emptyText = "keine Einträge"): HTMLElement {
  const template = columns.map((c) => c.width).join(" ");
  const line = (cells: Child[], cls: string) => {
    const row = h("div", { class: cls });
    row.style.gridTemplateColumns = template; // CSSOM – mit der CSP erlaubt
    cells.forEach((cell, i) =>
      row.append(h("span", { class: columns[i].align === "right" ? "cell right" : "cell" }, cell)),
    );
    return row;
  };
  const el = h("div", { class: "ttable", role: "table" });
  el.append(line(columns.map((c) => headCell(c)), "trow thead"));
  if (rows.length === 0) el.append(h("div", { class: "dim tempty" }, emptyText));
  for (const r of rows) el.append(line(columns.map((c) => c.cell(r)), "trow"));
  return el;
}

/** Klickbarer Wert: kopiert sich selbst, Rückmeldung in der Statusleiste. */
export function copyable(value: string, text: string = value): HTMLElement {
  return h(
    "button",
    {
      class: "value",
      type: "button",
      title: "Klicken zum Kopieren",
      onclick: async () => {
        // dynamischer Import vermeidet eine Import-Schleife widgets ↔ statusbar
        const { status } = await import("./statusbar");
        if (await copyText(value)) status(`kopiert: ${value}`, "ok");
        else status("Kopieren fehlgeschlagen", "error");
      },
    },
    text,
  );
}

/** Balken aus Blockzeichen für einen Wert 0..1, z. B. Signalstärke: ██████░░░░ */
export function bar(fraction: number, width = 10): HTMLElement {
  const f = Math.max(0, Math.min(1, fraction));
  const full = Math.round(f * width);
  return h(
    "span",
    { class: "tbar", "aria-hidden": "true" },
    h("span", { class: "accent-text" }, "█".repeat(full)),
    h("span", { class: "dim" }, "░".repeat(width - full)),
  );
}

/** Textbalken wie [#####-----] (z. B. Signal, Kanal-Belegung). Rein als Text, ohne Farbe. */
export function hashBar(fraction: number, width = 10): HTMLElement {
  const f = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const full = Math.round(f * width);
  return h(
    "span",
    { class: "hbar", "aria-hidden": "true" },
    h("span", { class: "dim" }, "["),
    h("span", { class: "plain" }, "#".repeat(full)),
    h("span", { class: "dim" }, "-".repeat(width - full) + "]"),
  );
}
