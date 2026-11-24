// Komfort-Funktionen zum Starten von Befehlen und Aktionen: vergeben die
// runId, sammeln die Ausgabe und liefern ein Promise, das beim Ende erfüllt wird.
import { backend } from "./api";
import { events } from "./events";
import type { ActionId, NetCommand, StepEvent } from "./types";

// Startwert zufällig-ish, damit nach einem Neuladen der Seite keine runId
// doppelt vergeben wird, solange ein alter Prozess noch läuft.
let nextId = (Date.now() % 1_000_000) * 1000;

export interface RunResult {
  exitCode: number | null;
  cancelled: boolean;
  lines: string[];
  /** 1-basiert: erster gescheiterter Schritt (null = keiner) */
  failedStep: number | null;
  /** Prozess liess sich nicht starten */
  error: string | null;
}

export interface RunHandle {
  runId: number;
  done: Promise<RunResult>;
  cancel(): Promise<void>;
}

export interface RunCallbacks {
  onLine?: (line: string, stream: "stdout" | "stderr") => void;
  onStep?: (step: StepEvent) => void;
}

/** Neue runId (passt in u32). Auch für Abläufe, die nicht über startRun laufen (IP-Profile). */
export function nextRunId(): number {
  nextId = (nextId + 1) % 0xe000_0000; // darüber: Backend-Wiederherstellung (0xE…) und logToConsole (0xF…)
  return nextId;
}

/** Gemeinsamer Ablauf: Listener anmelden, dann im Backend starten. */
async function startRun(start: (runId: number) => Promise<void>, cb: RunCallbacks): Promise<RunHandle> {
  const runId = nextRunId();
  const lines: string[] = [];
  let resolve!: (r: RunResult) => void;
  const done = new Promise<RunResult>((r) => (resolve = r));

  // Wichtig: Listener VOR dem Start registrieren, sonst gehen frühe Zeilen verloren.
  const offOutput = events.output.on((e) => {
    if (e.runId !== runId) return;
    lines.push(e.line);
    cb.onLine?.(e.line, e.stream);
  });
  const offStep = events.step.on((e) => {
    if (e.runId === runId) cb.onStep?.(e);
  });
  const off = () => {
    offOutput();
    offStep();
    offFinished();
  };
  const offFinished = events.finished.on((e) => {
    if (e.runId !== runId) return;
    off();
    resolve({ exitCode: e.exitCode, cancelled: e.cancelled, lines, failedStep: e.failedStep, error: e.error });
  });

  try {
    await start(runId);
  } catch (err) {
    off();
    throw err;
  }
  return { runId, done, cancel: () => backend.cancelCommand(runId) };
}

/** Ping oder Traceroute starten. */
export function startCommand(
  command: NetCommand,
  onLine?: (line: string, stream: "stdout" | "stderr") => void,
): Promise<RunHandle> {
  return startRun((runId) => backend.runCommand(runId, command), { onLine });
}

/** Aktion aus der Whitelist starten (nur die ID geht ans Backend). */
export function startAction(action: ActionId, adapter: string | null, cb: RunCallbacks = {}): Promise<RunHandle> {
  return startRun((runId) => backend.runAction(runId, action, adapter), cb);
}

// Für Werkzeuge ohne eigenen Prozess (DNS, Port-Test, Tabellen): Ergebnis
// trotzdem in der Konsole protokollieren – im gleichen Format wie Befehle.
let logId = 0xf000_0000;

export function logToConsole(commandLine: string, lines: string[], exitCode = 0): void {
  const runId = logId++;
  events.started.emit({ runId, commandLine });
  for (const line of lines) events.output.emit({ runId, stream: "stdout", line });
  events.finished.emit({ runId, exitCode, cancelled: false, failedStep: null, error: null });
}
