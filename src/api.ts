// Brücke zum Rust-Backend. Läuft die Seite im normalen Browser (ohne
// Tauri), werden automatisch Mock-Daten verwendet (siehe mock.ts).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { events } from "./events";
import * as mock from "./mock";
import type { AdapterInfo, FinishedEvent, NetCommand, OutputEvent, StartedEvent } from "./types";

/** true, wenn wir in der echten Tauri-App laufen. */
export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Einmal beim Start aufrufen: Tauri-Events an unseren Verteiler anschliessen. */
export async function initBackend(): Promise<void> {
  if (!isTauri) {
    console.info("[Net-Conf] Keine Tauri-API gefunden – Mock-Modus aktiv.");
    return;
  }
  await Promise.all([
    listen<StartedEvent>("cmd-started", (e) => events.started.emit(e.payload)),
    listen<OutputEvent>("cmd-output", (e) => events.output.emit(e.payload)),
    listen<FinishedEvent>("cmd-finished", (e) => events.finished.emit(e.payload)),
  ]);
}

export const backend = {
  getAdapters: (): Promise<AdapterInfo[]> =>
    isTauri ? invoke<AdapterInfo[]>("get_adapters") : mock.getAdapters(),

  getHostname: (): Promise<string> =>
    isTauri ? invoke<string>("get_hostname") : mock.getHostname(),

  isAdmin: (): Promise<boolean> => (isTauri ? invoke<boolean>("is_admin") : mock.isAdmin()),

  restartAsAdmin: (): Promise<void> =>
    isTauri ? invoke<void>("restart_as_admin") : mock.restartAsAdmin(),

  runCommand: (runId: number, command: NetCommand): Promise<void> =>
    isTauri ? invoke<void>("run_command", { runId, command }) : mock.runCommand(runId, command),

  cancelCommand: (runId: number): Promise<void> =>
    isTauri ? invoke<void>("cancel_command", { runId }) : mock.cancelCommand(runId),
};

/** Fehler aus invoke() (meist ein String vom Backend) lesbar machen. */
export function errorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return String(err);
}
