// Statusleiste ganz unten (wie bei vim/tmux).
// Links: Version, Adapteranzahl, ausgeblendete Adapter.
// Rechts: letzte Rückmeldung (z. B. "kopiert: 192.168.1.42") und Admin-Status.
// Ersetzt die früheren Toasts.
import { onStateChange, state } from "../state";
import { h } from "./dom";

export type MsgKind = "info" | "ok" | "error";

const msgEl = h("span", { class: "sb-msg", role: "status", "aria-live": "polite" });

/** Rückmeldung in der Statusleiste anzeigen. Bleibt stehen bis zur nächsten. */
export function status(text: string, kind: MsgKind = "info"): void {
  msgEl.textContent = text;
  msgEl.title = text;
  msgEl.className = `sb-msg msg-${kind}`;
}

export function createStatusbar(): HTMLElement {
  const left = h("span", { class: "sb-left" });
  const admin = h("span", { class: "sb-admin" });
  const sep = () => h("span", { class: "sb-sep" }, " │ ");

  const render = () => {
    const total = state.adapters.length;
    const hidden = state.hideDisconnected ? state.adapters.filter((a) => !a.connected).length : 0;
    left.replaceChildren(
      `net-conf v${__APP_VERSION__}`,
      sep(),
      state.loading && total === 0 ? "lade …" : `${total} Adapter`,
      sep(),
      `${hidden} ausgeblendet`,
    );
    admin.textContent = state.isAdmin ? "[ADMIN]" : "[USER]";
    admin.className = `sb-admin ${state.isAdmin ? "tag-ok" : ""}`;
  };
  onStateChange(render);
  render();

  return h("footer", { class: "statusbar" }, left, h("span", { class: "spacer" }), msgEl, sep(), admin);
}
