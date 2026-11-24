// Kleiner Event-Verteiler. Sowohl echte Tauri-Events als auch die
// Mock-Daten im Browser landen hier – der Rest der App merkt keinen Unterschied.
import type { FinishedEvent, OutputEvent, StartedEvent } from "./types";

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
  output: new Emitter<OutputEvent>(),
  finished: new Emitter<FinishedEvent>(),
};
