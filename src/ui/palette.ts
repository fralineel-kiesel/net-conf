// Befehlspalette (Strg+K): Overlay-Panel oben mittig mit Eingabezeile ">" und Trefferliste.
//
//   ↑/↓ wählen · Enter ausführen · Tab Parameter ergänzen · Esc schliessen
//
// Die Befehle kommen aus der Registry (src/registry.ts). Ausgeführt wird immer
// erst NACH dem Schliessen – Bestätigungsdialoge der Befehle erscheinen also normal.
import { errorText } from "../api";
import { fuzzyFilter } from "../fuzzy";
import { allCommands, type PaletteCommand } from "../registry";
import { h, replaceChildren } from "./dom";
import { status } from "./statusbar";
import { panel } from "./widgets";

interface Entry {
  cmd: PaletteCommand;
  /** Parameter (null = Befehl ohne Parameter bzw. noch keiner eingegeben) */
  arg: string | null;
  label: string;
  error: string | null;
}

const MAX_ENTRIES = 60;

let backdrop: HTMLElement | null = null;

export function paletteOpen(): boolean {
  return backdrop !== null;
}

export function togglePalette(): void {
  if (backdrop) closePalette();
  else openPalette();
}

let closeFn: (() => void) | null = null;

export function closePalette(): void {
  closeFn?.();
}

/** Trefferliste zur Eingabe bauen (inkl. Befehle mit Parameter wie "ping 1.1.1.1"). */
function buildEntries(query: string): Entry[] {
  const all = allCommands();
  const trimmed = query.trimStart();
  const space = trimmed.search(/\s/);
  const word = (space < 0 ? trimmed : trimmed.slice(0, space)).toLowerCase();
  const paramCmd = all.find((c) => c.param && c.param.keyword === word);

  if (paramCmd?.param && space >= 0) {
    const p = paramCmd.param;
    const arg = trimmed.slice(space).trim();
    const out: Entry[] = [];
    const suggestions = fuzzyFilter(arg, p.suggest?.() ?? [], (s) => [s]);
    if (arg && !suggestions.some((s) => s.toLowerCase() === arg.toLowerCase())) {
      out.push({ cmd: paramCmd, arg, label: `${p.keyword} ${arg}`, error: p.validate(arg) });
    }
    for (const s of suggestions.slice(0, 20)) out.push({ cmd: paramCmd, arg: s, label: `${p.keyword} ${s}`, error: p.validate(s) });
    if (!out.length) out.push({ cmd: paramCmd, arg: null, label: `${p.keyword} ${p.placeholder}`, error: null });
    return out;
  }

  return fuzzyFilter(query, all, (c) => [c.title, c.param?.keyword ?? "", c.keywords ?? "", c.category])
    .slice(0, MAX_ENTRIES)
    .map((c) => ({ cmd: c, arg: null, label: c.param ? `${c.param.keyword} ${c.param.placeholder}` : c.title, error: null }));
}

export function openPalette(prefill = ""): void {
  if (backdrop) return;
  const previousFocus = document.activeElement as HTMLElement | null;
  const input = h("input", {
    class: "tinput palette-input",
    type: "text",
    spellcheck: "false",
    autocomplete: "off",
    placeholder: "Befehl suchen … z. B. wlan, dns leeren, ping 1.1.1.1",
    "aria-label": "Befehl",
    role: "combobox",
    "aria-expanded": "true",
    "aria-controls": "palette-list",
  });
  input.value = prefill;
  const list = h("div", { class: "palette-list", id: "palette-list", role: "listbox" });
  const msg = h("div", { class: "palette-msg dim" }, "↑↓ wählen · Enter ausführen · Tab ergänzen · Esc schliessen");
  const box = panel(
    "BEFEHLSPALETTE",
    { cls: "palette", right: [h("span", { class: "dim" }, "Strg+K")] },
    h("div", { class: "palette-line" }, h("span", { class: "dim" }, "> "), input),
    list,
    msg,
  );
  box.el.setAttribute("role", "dialog");
  box.el.setAttribute("aria-label", "Befehlspalette");
  backdrop = h("div", { class: "palette-backdrop" }, box.el);

  let entries: Entry[] = [];
  let sel = 0;
  const rows: HTMLElement[] = [];

  const select = (i: number, scroll = true) => {
    if (!entries.length) return;
    sel = (i + entries.length) % entries.length;
    rows.forEach((r, k) => {
      r.classList.toggle("selected", k === sel);
      r.setAttribute("aria-selected", String(k === sel));
    });
    if (scroll) rows[sel]?.scrollIntoView({ block: "nearest" });
  };

  const render = () => {
    entries = buildEntries(input.value);
    rows.length = 0;
    if (!entries.length) {
      replaceChildren(list, h("div", { class: "dim palette-empty" }, "keine Treffer"));
      return;
    }
    replaceChildren(
      list,
      ...entries.map((e, i) => {
        const row = h(
          "button",
          { class: "pal-item", type: "button", role: "option", tabindex: "-1" },
          h("span", { class: "pal-cat" }, `[${e.cmd.category}]`),
          h("span", { class: "pal-label" }, e.label),
          e.error
            ? h("span", { class: "pal-hint tag-err" }, e.error)
            : h("span", { class: "pal-hint" }, e.cmd.param && e.arg === null ? "Tab/Enter ergänzt" : (e.cmd.hint ?? "")),
        );
        row.addEventListener("mousemove", () => {
          if (sel !== i) select(i, false);
        });
        row.addEventListener("mousedown", (ev) => ev.preventDefault()); // Fokus bleibt im Eingabefeld
        row.addEventListener("click", () => void run(i));
        rows.push(row);
        return row;
      }),
    );
    select(0);
  };

  /** Parameter-Befehl ohne Parameter: Schlüsselwort ins Feld schreiben statt ausführen */
  const complete = (e: Entry) => {
    input.value = `${e.cmd.param!.keyword} `;
    render();
  };

  async function run(i: number): Promise<void> {
    const e = entries[i];
    if (!e) return;
    if (e.cmd.param && e.arg === null) return complete(e);
    if (e.error) {
      msg.className = "palette-msg tag-err";
      msg.textContent = e.error;
      return;
    }
    close(false);
    try {
      await e.cmd.run(e.arg ?? undefined);
    } catch (err) {
      status(errorText(err), "error");
    }
  }

  const close = (restoreFocus: boolean) => {
    document.removeEventListener("keydown", onKey, true);
    backdrop?.remove();
    backdrop = null;
    closeFn = null;
    if (restoreFocus) previousFocus?.focus?.();
  };
  closeFn = () => close(true);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      select(sel + (e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "PageDown" || e.key === "PageUp") {
      e.preventDefault();
      select(Math.max(0, Math.min(entries.length - 1, sel + (e.key === "PageDown" ? 8 : -8))));
    } else if (e.key === "Enter") {
      e.preventDefault();
      void run(sel);
    } else if (e.key === "Tab") {
      e.preventDefault();
      const cur = entries[sel];
      if (cur?.cmd.param) {
        input.value = cur.arg === null ? `${cur.cmd.param.keyword} ` : `${cur.cmd.param.keyword} ${cur.arg}`;
        render();
      }
    }
  };

  input.addEventListener("input", () => {
    msg.className = "palette-msg dim";
    msg.textContent = "↑↓ wählen · Enter ausführen · Tab ergänzen · Esc schliessen";
    render();
  });
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) close(true);
  });
  document.addEventListener("keydown", onKey, true);
  document.body.append(backdrop);
  render();
  input.focus();
}
