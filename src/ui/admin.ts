// Dialog "Als Administrator neu starten" – wird von mehreren Stellen genutzt.
import { backend, errorText, isTauri } from "../api";
import { confirmDialog } from "./modal";
import { toast } from "./toast";

export async function askRestartAsAdmin(reason?: string): Promise<void> {
  const ok = await confirmDialog({
    title: "Administratorrechte benötigt",
    message:
      (reason ? reason + " " : "") +
      "Net-Conf wird dazu als Administrator neu gestartet. Windows fragt anschliessend nach deiner Bestätigung.",
    confirmText: "Als Administrator neu starten",
  });
  if (!ok) return;
  try {
    await backend.restartAsAdmin();
    if (!isTauri) toast("Mock: Neustart als Administrator simuliert", "info");
  } catch (err) {
    toast(errorText(err), "error");
  }
}
