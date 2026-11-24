// Übersetzt fehlgeschlagene Befehle in verständliche deutsche Meldungen.
// Die Rohausgabe bleibt trotzdem in der Konsole sichtbar.
//
// Hinweis: Hier wird NICHT nach Erfolg geparst (sprachabhängig!), nur bei
// einem Fehler nach bekannten Stichwörtern gesucht, um die Meldung zu verbessern.
import type { ActionDef } from "./actions";
import type { NetCommand } from "./types";

export const ADMIN_NEEDED = "Dafür werden Administratorrechte benötigt.";

const needsElevation = (text: string) =>
  text.includes("erhöhte rechte") || text.includes("elevation") || text.includes("zugriff verweigert");

/** Ping / Traceroute */
export function explainFailure(command: NetCommand, exitCode: number | null, lines: string[]): string {
  const text = lines.join("\n").toLowerCase();
  if (needsElevation(text)) return ADMIN_NEEDED;

  switch (command.kind) {
    case "tracert":
      if (text.includes("nicht aufgelöst") || text.includes("unable to resolve") || text.includes("nicht finden")) {
        return `Der Host „${command.target.trim()}“ wurde nicht gefunden. Bitte Namen prüfen.`;
      }
      break;
    case "ping":
      if (text.includes("nicht finden") || text.includes("could not find")) {
        return `Der Host „${command.target.trim()}“ wurde nicht gefunden. Bitte Namen prüfen.`;
      }
      return "Keine Antwort vom Ziel erhalten.";
  }
  return `Der Befehl ist fehlgeschlagen (Code ${exitCode ?? "?"}). Details stehen in der Konsole.`;
}

/** Grund für einen gescheiterten Aktions-Schritt (ohne "Schritt x/y"). */
export function explainActionFailure(
  def: ActionDef,
  adapter: string | null,
  exitCode: number | null,
  lines: string[],
  isAdmin: boolean,
): string {
  const text = lines.join("\n").toLowerCase();
  // Bekannt: "netsh int ip reset" meldet auch als Admin oft "Zugriff verweigert"
  // für einen einzelnen Registry-Schlüssel – der Rest wurde trotzdem zurückgesetzt.
  if (def.id === "tcpipReset" && isAdmin && text.includes("zugriff")) {
    return "Ein Teil liess sich nicht zurücksetzen (Zugriff verweigert). Das ist bei Windows häufig – trotzdem neu starten.";
  }
  if (needsElevation(text) || (def.admin && !isAdmin)) return ADMIN_NEEDED;
  if (text.includes("dhcp-server") || text.includes("dhcp server")) {
    return "Der DHCP-Server antwortet nicht. Kabel/WLAN prüfen oder den Router neu starten.";
  }
  if (text.includes("medium getrennt") || text.includes("media disconnected")) {
    return adapter
      ? "Der Adapter ist nicht verbunden (Kabel/WLAN getrennt)."
      : "Mindestens ein Adapter ist getrennt (Kabel/WLAN) – bei den verbundenen kann es trotzdem geklappt haben.";
  }
  return `Code ${exitCode ?? "?"} – Details stehen in der Konsole.`;
}
