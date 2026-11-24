// Bestätigungsdialog im TUI-Stil: Panel mit Titel in der Linie, Buttons als [ Text ].
import { h } from "./dom";
import { panel, tbutton } from "./widgets";

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmText: string;
  cancelText?: string;
  /** Gefährliche Aktion: Fokus liegt dann zuerst auf "Abbrechen". */
  danger?: boolean;
  /** Reiner Hinweis: nur ein Button (confirmText), kein "Abbrechen". */
  infoOnly?: boolean;
}

/** true, solange ein Dialog offen ist (Tastenkürzel werden dann ignoriert). */
export function dialogOpen(): boolean {
  return document.querySelector(".dialog-backdrop") !== null;
}

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const close = (result: boolean) => {
      document.removeEventListener("keydown", onKey, true);
      backdrop.remove();
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(false);
      }
    };

    const cancelBtn = tbutton(opts.cancelText ?? "Abbrechen", { onclick: () => close(false) });
    const okBtn = tbutton(opts.confirmText, { onclick: () => close(true) });
    const box = panel(
      opts.title.toUpperCase(),
      { cls: "dialog" },
      h("p", {}, opts.message),
      h("div", { class: "dialog-actions" }, opts.infoOnly ? null : cancelBtn, okBtn),
    );
    box.el.setAttribute("role", "dialog");
    box.el.setAttribute("aria-modal", "true");
    box.el.setAttribute("aria-label", opts.title);

    const backdrop = h("div", { class: "dialog-backdrop" }, box.el);
    backdrop.addEventListener("mousedown", (e) => {
      if (e.target === backdrop) close(false);
    });
    document.addEventListener("keydown", onKey, true);
    document.body.append(backdrop);
    (opts.danger && !opts.infoOnly ? cancelBtn : okBtn).focus();
  });
}
