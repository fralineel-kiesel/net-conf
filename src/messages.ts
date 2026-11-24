// Übersetzt fehlgeschlagene Befehle in verständliche deutsche Meldungen.
// Die Rohausgabe bleibt trotzdem in der Konsole sichtbar.
import type { NetCommand } from "./types";

export const ADMIN_NEEDED = "Dafür werden Administratorrechte benötigt.";

export function explainFailure(
  command: NetCommand,
  exitCode: number | null,
  lines: string[],
  isAdmin: boolean,
): string {
  const text = lines.join("\n").toLowerCase();

  // Deutsch: "erfordert erhöhte Rechte", Englisch: "requires elevation"
  if (text.includes("erhöhte rechte") || text.includes("elevation") || text.includes("zugriff verweigert")) {
    return ADMIN_NEEDED;
  }

  switch (command.kind) {
    case "release":
    case "renew":
      if (!isAdmin) return ADMIN_NEEDED;
      if (text.includes("medium getrennt") || text.includes("media disconnected")) {
        return "Der Adapter ist nicht verbunden (Kabel/WLAN getrennt).";
      }
      return command.kind === "renew"
        ? "Die IP-Adresse konnte nicht erneuert werden. Ist der Adapter verbunden und auf DHCP eingestellt? Details in der Konsole."
        : "Die IP-Adresse konnte nicht freigegeben werden. Details in der Konsole.";
    case "registerDns":
      if (!isAdmin) return ADMIN_NEEDED;
      break;
    case "ping":
      if (text.includes("nicht finden") || text.includes("could not find")) {
        return `Der Host „${command.target.trim()}“ wurde nicht gefunden. Bitte Namen prüfen.`;
      }
      return "Keine Antwort vom Ziel erhalten.";
  }
  return `Der Befehl ist fehlgeschlagen (Code ${exitCode ?? "?"}). Details stehen in der Konsole.`;
}
