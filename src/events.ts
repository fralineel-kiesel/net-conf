// Kleiner Event-Verteiler. Sowohl echte Tauri-Events als auch die
// Mock-Daten im Browser landen hier – der Rest der App merkt keinen Unterschied.
import type {
  FinishedEvent,
  LanFinishedEvent,
  LanHostEvent,
  LanProgressEvent,
  MonitorUpdate,
  OutputEvent,
  StartedEvent,
  StepEvent,
} from "./types";

type Handler<T> = (event: T) => void;

export class Emitter<T> {
  private handlers = new Set<Handler<T>>();

  /** Registriert einen Handler und gibt eine Abmelde-Funktion zurück. */
  on(handler: Handler<T>): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emit(event: T): void {
    for (const h of this.handlers) h(event);
  }
}

export const events = {
  started: new Emitter<StartedEvent>(),
  step: new Emitter<StepEvent>(),
  output: new Emitter<OutputEvent>(),
  finished: new Emitter<FinishedEvent>(),
  // Phase 4a: Ping-Monitor und LAN-Scan (Backend-Threads)
  monitor: new Emitter<MonitorUpdate>(),
  lanHost: new Emitter<LanHostEvent>(),
  lanProgress: new Emitter<LanProgressEvent>(),
  lanFinished: new Emitter<LanFinishedEvent>(),
};
