// Komfort-Funktion zum Starten eines Befehls: vergibt die runId,
// sammelt die Ausgabe und liefert ein Promise, das beim Ende erfüllt wird.
import { backend } from "./api";
import { events } from "./events";
import type { NetCommand } from "./types";

// Startwert zufällig-ish, damit nach einem Neuladen der Seite keine runId
// doppelt vergeben wird, solange ein alter Prozess noch läuft.
let nextId = (Date.now() % 1_000_000) * 1000;

export interface RunResult {
  exitCode: number | null;
  cancelled: boolean;
  lines: string[];
}

export interface RunHandle {
  runId: number;
  done: Promise<RunResult>;
  cancel(): Promise<void>;
}

export async function startCommand(
  command: NetCommand,
  onLine?: (line: string, stream: "stdout" | "stderr") => void,
): Promise<RunHandle> {
  nextId = (nextId + 1) % 0xffff_ffff; // passt in u32
  const runId = nextId;
  const lines: string[] = [];
  let resolve!: (r: RunResult) => void;
  const done = new Promise<RunResult>((r) => (resolve = r));

  // Wichtig: Listener VOR dem Start registrieren, sonst gehen frühe Zeilen verloren.
  const offOutput = events.output.on((e) => {
    if (e.runId !== runId) return;
    lines.push(e.line);
    onLine?.(e.line, e.stream);
  });
  const offFinished = events.finished.on((e) => {
    if (e.runId !== runId) return;
    offOutput();
    offFinished();
    resolve({ exitCode: e.exitCode, cancelled: e.cancelled, lines });
  });

  try {
    await backend.runCommand(runId, command);
  } catch (err) {
    offOutput();
    offFinished();
    throw err;
  }
  return { runId, done, cancel: () => backend.cancelCommand(runId) };
}
