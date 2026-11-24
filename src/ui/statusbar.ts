// Statusleiste ganz unten (wie bei vim/tmux).
// Links: Version, Adapteranzahl, ausgeblendete Adapter.
// Rechts: letzte Rückmeldung (z. B. "kopiert: 192.168.1.42") und Admin-Status.
// Läuft der Ping-Monitor, steht links zusätzlich "Monitor: 4 Ziele, 1 DOWN".
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

const monitorEl = h("span", { class: "sb-monitor" });
monitorEl.hidden = true;

/** Ping-Monitor-Zusammenfassung (null = Monitor läuft nicht → ausblenden). */
export function setMonitorSummary(s: { total: number; down: number } | null): void {
  monitorEl.hidden = s === null;
  if (!s) return;
  monitorEl.replaceChildren(
    h("span", { class: "sb-sep" }, " │ "),
    `Monitor: ${s.total} ${s.total === 1 ? "Ziel" : "Ziele"}, `,
    h("span", { class: s.down > 0 ? "tag-err" : "tag-ok" }, `${s.down} DOWN`),
  );
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

  return h("footer", { class: "statusbar" }, left, monitorEl, h("span", { class: "spacer" }), msgEl, sep(), admin);
}
