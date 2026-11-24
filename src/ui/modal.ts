// Einfacher Bestätigungsdialog (statt window.confirm, passt optisch besser).
import { h } from "./dom";

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmText: string;
  cancelText?: string;
  danger?: boolean;
}

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const close = (result: boolean) => {
      document.removeEventListener("keydown", onKey);
      backdrop.classList.add("leaving");
      setTimeout(() => backdrop.remove(), 140);
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(false);
    };

    const okBtn = h(
      "button",
      { class: `btn ${opts.danger ? "btn-danger" : "btn-primary"}`, onclick: () => close(true) },
      opts.confirmText,
    );
    const dialog = h(
      "div",
      { class: "modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "modal-title" },
      h("h2", { id: "modal-title" }, opts.title),
      h("p", {}, opts.message),
      h(
        "div",
        { class: "modal-actions" },
        h("button", { class: "btn btn-ghost", onclick: () => close(false) }, opts.cancelText ?? "Abbrechen"),
        okBtn,
      ),
    );
    const backdrop = h("div", { class: "modal-backdrop" }, dialog);
    backdrop.addEventListener("mousedown", (e) => {
      if (e.target === backdrop) close(false);
    });
    document.addEventListener("keydown", onKey);
    document.body.append(backdrop);
    okBtn.focus();
  });
}
