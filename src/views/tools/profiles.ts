// Werkzeuge → IP-Profile: feste oder DHCP-Konfiguration pro Adapter speichern
// und per netsh anwenden – mit Sicherheitsnetz (30 s „Behalten“, sonst zurück).
//
// Ablauf beim Anwenden:
//   1. Profil speichern (falls geändert) – das Backend liest es aus config.json
//   2. Vorschau vom Backend holen (alt → neu, netsh-Befehle) → Bestätigung [!]
//   3. ip_profile_apply: Schritte laufen in der Konsole mit
//   4. Event "ip-profile" pending → Countdown-Dialog „Verbindung ok?“
//      [ Behalten ] → kept,  sonst nach 30 s → das BACKEND stellt wieder her
import { backend, errorText } from "../../api";
import { nextRunId } from "../../commands";
import { config, onConfigChange, updateConfig } from "../../config";
import { events } from "../../events";
import { checkProfile, describeProfile, emptyProfile, profileFromAdapter } from "../../ipprofile";
import { maskToPrefix } from "../../netutil";
import { onStateChange, primaryAdapter, refreshAll, setState, sortedAdapters, state } from "../../state";
import type { IpProfile, IpProfileEvent } from "../../types";
import { askRestartAsAdmin } from "../../ui/admin";
import { h, replaceChildren } from "../../ui/dom";
import { confirmDialog } from "../../ui/modal";
import { status } from "../../ui/statusbar";
import { choice, kvRow, panel, prompt, table, tag, tbutton } from "../../ui/widgets";

export interface ProfilesView {
  el: HTMLElement;
  /** Profil auswählen und anwenden (z. B. aus der Befehlspalette) – mit allen Dialogen */
  applyByName(name: string): Promise<void>;
}

const MISSING = "__missing__";

export function createProfiles(): ProfilesView {
  /** Name des gespeicherten Profils im Formular (null = neues Profil) */
  let selected: string | null = null;
  /** Adapter des Profils, falls er gerade nicht in der Liste ist (z. B. USB-Adapter abgesteckt) */
  let missing: { name: string; mac: string } | null = null;
  let mode: IpProfile["mode"] = "static";
  /** Hat der Benutzer schon etwas im Formular gemacht? (sonst darf es beim Laden der Config wechseln) */
  let touched = false;

  const input = (placeholder: string, label: string, short = true) =>
    h("input", {
      class: short ? "tinput tinput-short" : "tinput",
      type: "text",
      placeholder,
      spellcheck: "false",
      autocomplete: "off",
      "aria-label": label,
    });
  const field = (el: HTMLInputElement) => h("span", { class: "input-wrap" }, h("span", { class: "dim" }, "> "), el);

  const nameIn = input("z. B. Labor statisch", "Profilname", false);
  nameIn.maxLength = 40;
  const adapterSel = h("select", { class: "tselect", "aria-label": "Adapter" });
  const modeChoice = choice<IpProfile["mode"]>(
    [
      { value: "dhcp", label: "DHCP", title: "IP-Adresse automatisch vom DHCP-Server" },
      { value: "static", label: "STATISCH", title: "Feste IP-Adresse" },
    ],
    mode,
    (v) => {
      mode = v;
      touched = true;
      renderMode();
      renderForm();
    },
  );
  const ipIn = input("192.168.1.50", "IPv4-Adresse");
  const subnetIn = input("255.255.255.0 oder /24", "Subnetzmaske oder Präfix");
  const gwIn = input("optional", "Gateway");
  const dns1In = input("", "DNS 1");
  const dns2In = input("optional", "DNS 2");
  const dnsHint = h("span", { class: "dim" });
  const formMsg = h("p", { class: "note" });

  const saveBtn = tbutton("Speichern", { onclick: () => void save() });
  const fromAdapterBtn = tbutton("Aus aktuellem Adapter übernehmen", {
    title: "Aktuelle IP-Einstellungen des gewählten Adapters ins Formular übernehmen",
    onclick: () => void takeFromAdapter(),
  });
  const applyBtn = tbutton("Anwenden", { onclick: () => void apply() });
  const applyFlags = h("span", { class: "action-flags" });
  const deleteBtn = tbutton("Löschen", { onclick: () => void remove() });
  const newBtn = tbutton("Neu", { title: "Leeres Profil anlegen", onclick: () => loadForm(null) });

  const listBody = h("div", {});
  const listPanel = panel("PROFILE", { right: [newBtn] }, listBody);
  const formPanel = panel(
    "PROFIL",
    {},
    kvRow("Name", field(nameIn)),
    kvRow("Adapter", h("span", { class: "select-wrap" }, adapterSel)),
    kvRow("Modus", modeChoice.el),
    kvRow("IPv4", field(ipIn)),
    kvRow("Subnetzmaske", field(subnetIn)),
    kvRow("Gateway", field(gwIn)),
    kvRow("DNS 1", h("span", { class: "row-actions" }, field(dns1In), dnsHint)),
    kvRow("DNS 2", field(dns2In)),
    formMsg,
    h(
      "div",
      { class: "panel-actions row-actions wrap-actions" },
      saveBtn,
      fromAdapterBtn,
      h("span", { class: "row-actions" }, applyBtn, applyFlags),
      deleteBtn,
    ),
  );
  const infoPanel = panel(
    "SICHERHEITSNETZ",
    {},
    h(
      "p",
      {},
      "Vor dem Anwenden sichert Net-Conf die aktuelle Konfiguration des Adapters. Danach hast du ",
      h("span", { class: "plain" }, "30 Sekunden"),
      " Zeit, mit [ Behalten ] zu bestätigen – sonst wird die vorherige Konfiguration automatisch wiederhergestellt (auch wenn die Verbindung weg ist).",
    ),
    h("p", { class: "dim note" }, "Gesichert werden die erste IPv4-Adresse, Maske, Gateway und bis zu zwei DNS-Server. Der Adapter wird über seine MAC-Adresse wiedererkannt."),
  );
  const el = h(
    "div",
    { class: "subview profiles" },
    prompt("netsh interface ipv4 set address").el,
    h("div", { class: "stack" }, listPanel.el, formPanel.el, infoPanel.el),
  );

  // --- Formular -------------------------------------------------------------

  const savedProfile = () => config().ipProfiles.find((p) => p.name === selected) ?? null;

  /** Formular → Profil */
  function readForm(): IpProfile {
    const a = state.adapters.find((x) => x.id === adapterSel.value);
    return {
      name: nameIn.value.trim(),
      adapter: a?.name ?? missing?.name ?? "",
      mac: a?.mac ?? missing?.mac ?? "",
      mode,
      ipv4: mode === "static" ? ipIn.value.trim() : "",
      subnet: mode === "static" ? subnetIn.value.trim() : "",
      gateway: mode === "static" ? gwIn.value.trim() : "",
      dns1: dns1In.value.trim(),
      dns2: dns2In.value.trim(),
    };
  }

  /** Ungespeicherte Änderungen? (Maske "/24" und "255.255.255.0" gelten als gleich, Backend normalisiert) */
  function dirty(): boolean {
    const s = savedProfile();
    if (!s) return true;
    const f = readForm();
    return describeProfile(f) !== describeProfile(s) || f.name !== s.name || f.mac !== s.mac || f.adapter !== s.adapter;
  }

  function renderAdapters(): void {
    const prev = adapterSel.value;
    const opts = sortedAdapters(state.adapters).map((a) =>
      h("option", { value: a.id }, `${a.name}${a.mac ? ` (${a.mac})` : ""}${a.connected ? "" : " – getrennt"}`),
    );
    if (missing) opts.unshift(h("option", { value: MISSING }, `${missing.name} (${missing.mac || "ohne MAC"}) – nicht gefunden`));
    if (!opts.length) opts.push(h("option", { value: "" }, "keine Adapter"));
    adapterSel.replaceChildren(...opts);
    if (opts.some((o) => o.value === prev)) adapterSel.value = prev;
  }

  /** Profil (oder neues) ins Formular laden */
  function loadForm(p: IpProfile | null, byUser = true): void {
    touched = byUser;
    selected = p?.name ?? null;
    const prof = p ?? emptyProfile(primaryAdapter());
    const a =
      state.adapters.find((x) => prof.mac && x.mac === prof.mac) ??
      state.adapters.find((x) => !prof.mac && x.name === prof.adapter);
    missing = a || !p ? null : { name: prof.adapter, mac: prof.mac };
    renderAdapters();
    adapterSel.value = a?.id ?? (missing ? MISSING : (primaryAdapter()?.id ?? adapterSel.value));
    nameIn.value = prof.name;
    mode = prof.mode;
    modeChoice.set(mode);
    ipIn.value = prof.ipv4;
    subnetIn.value = prof.subnet;
    gwIn.value = prof.gateway;
    dns1In.value = prof.dns1;
    dns2In.value = prof.dns2;
    renderMode();
    renderForm();
    renderList();
    if (!p && byUser) nameIn.focus();
  }

  function renderMode(): void {
    for (const i of [ipIn, subnetIn, gwIn]) i.disabled = mode === "dhcp";
    dnsHint.textContent = mode === "dhcp" ? "leer = DNS automatisch (DHCP)" : "leer = kein DNS-Server";
  }

  function renderForm(): void {
    const err = checkProfile(readForm());
    formMsg.className = err ? "note tag-err" : "note dim";
    formMsg.textContent = err ?? (dirty() ? "Ungespeicherte Änderungen." : `Gespeichert: ${describeProfile(readForm())}`);
    const locked = !state.isAdmin;
    applyBtn.disabled = state.busy || !!err;
    applyBtn.classList.toggle("locked", locked);
    applyBtn.title = locked
      ? "Dafür werden Administratorrechte benötigt. Klicken, um Net-Conf als Administrator neu zu starten."
      : state.busy
        ? "Gesperrt, solange eine andere Aktion läuft"
        : "Profil auf den Adapter anwenden (mit 30 s Sicherheitsnetz)";
    replaceChildren(
      applyFlags,
      locked ? h("span", { class: "dim" }, "(Admin nötig)") : tag("[ADMIN]"),
      " ",
      tag("[!]", "err"),
    );
    deleteBtn.disabled = selected === null;
    saveBtn.disabled = !!err;
  }

  function renderList(): void {
    const list = config().ipProfiles;
    replaceChildren(
      listBody,
      table(
        [
          {
            title: "Name",
            width: "minmax(14ch, 1.2fr)",
            cell: (p) =>
              h(
                "button",
                { class: "pick", type: "button", title: "Profil bearbeiten", onclick: () => loadForm(p) },
                `${p.name === selected ? "> " : "  "}${p.name}`,
              ),
          },
          { title: "Adapter", width: "minmax(8ch, 1fr)", cell: (p) => h("span", { class: "ellipsis", title: `${p.adapter} ${p.mac}` }, p.adapter) },
          { title: "Modus", width: "11ch", cell: (p) => tag(p.mode === "dhcp" ? "[DHCP]" : "[STATISCH]") },
          {
            title: "IPv4",
            width: "19ch",
            cell: (p) => (p.mode === "dhcp" ? h("span", { class: "dim" }, "automatisch") : `${p.ipv4}/${maskToPrefix(p.subnet) ?? "?"}`),
          },
          { title: "Gateway", width: "15ch", cell: (p) => p.gateway || h("span", { class: "dim" }, "–") },
          {
            title: "DNS",
            width: "minmax(10ch, 1fr)",
            cell: (p) =>
              p.dns1
                ? h("span", { class: "ellipsis" }, [p.dns1, p.dns2].filter(Boolean).join(", "))
                : h("span", { class: "dim" }, p.mode === "dhcp" ? "automatisch" : "–"),
          },
        ],
        list,
        "noch keine Profile – [ Neu ] oder „Aus aktuellem Adapter übernehmen“",
      ),
    );
  }

  // --- Speichern, Löschen, Übernehmen -------------------------------------------

  async function save(): Promise<boolean> {
    const p = readForm();
    const err = checkProfile(p);
    if (err) {
      status(err, "error");
      renderForm();
      return false;
    }
    const list = config().ipProfiles.filter((x) => x.name !== selected);
    const index = config().ipProfiles.findIndex((x) => x.name === selected);
    list.splice(index >= 0 ? index : list.length, 0, p);
    try {
      await updateConfig({ ipProfiles: list });
    } catch (e) {
      formMsg.className = "note tag-err";
      formMsg.textContent = errorText(e);
      status(errorText(e), "error");
      return false;
    }
    selected = p.name;
    missing = null;
    loadForm(savedProfile());
    status(`IP-Profil „${p.name}“ gespeichert`, "ok");
    return true;
  }

  async function remove(): Promise<void> {
    const s = savedProfile();
    if (!s) return;
    const ok = await confirmDialog({
      title: "IP-Profil löschen?",
      message: `Das Profil „${s.name}“ wird gelöscht. Die Netzwerk-Einstellungen des Adapters ändern sich dadurch nicht.`,
      confirmText: "Löschen",
    });
    if (!ok) return;
    try {
      await updateConfig({ ipProfiles: config().ipProfiles.filter((x) => x.name !== s.name) });
      loadForm(null);
      status(`IP-Profil „${s.name}“ gelöscht`, "ok");
    } catch (e) {
      status(errorText(e), "error");
    }
  }

  async function takeFromAdapter(): Promise<void> {
    await refreshAll(); // aktuelle Werte, nicht die vom letzten Neuladen
    const a = state.adapters.find((x) => x.id === adapterSel.value);
    if (!a) return status("Bitte einen vorhandenen Adapter wählen.", "error");
    const p = profileFromAdapter(a, nameIn.value.trim() || `${a.name} (aktuell)`.slice(0, 40));
    missing = null;
    nameIn.value = p.name;
    mode = p.mode;
    modeChoice.set(mode);
    ipIn.value = p.ipv4;
    subnetIn.value = p.subnet;
    gwIn.value = p.gateway;
    dns1In.value = p.dns1;
    dns2In.value = p.dns2;
    renderAdapters();
    adapterSel.value = a.id;
    renderMode();
    renderForm();
    status(`Werte von „${a.name}“ übernommen – zum Behalten [ Speichern ]`, "ok");
  }

  // --- Anwenden + Sicherheitsnetz ----------------------------------------------------

  async function apply(): Promise<void> {
    if (state.busy) return;
    if (!state.isAdmin) return askRestartAsAdmin("„IP-Profil anwenden“ benötigt Administratorrechte.");
    if (dirty() && !(await save())) return;
    const name = selected;
    if (!name) return;
    let preview;
    try {
      preview = await backend.ipProfilePreview(name);
    } catch (e) {
      status(errorText(e), "error");
      return;
    }
    const ok = await confirmDialog({
      title: "IP-Profil anwenden?",
      message:
        `Profil:   ${preview.profile}\n` +
        `Adapter:  ${preview.adapter}${preview.mac ? ` (${preview.mac})` : ""}\n` +
        `alt:      ${preview.from}\n` +
        `neu:      ${preview.to}\n\n` +
        preview.notes.map((n) => `Hinweis: ${n}\n`).join("") +
        `Befehle:\n${preview.commands.map((c) => `  ${c}`).join("\n")}\n\n` +
        "Die Verbindung kann kurz unterbrochen werden. Danach hast du 30 s Zeit für [ Behalten ] – " +
        "sonst stellt Net-Conf die alte Konfiguration automatisch wieder her.",
      confirmText: "Anwenden",
      danger: true,
    });
    if (!ok) return;
    setState({ busy: true });
    status(`IP-Profil „${name}“ wird angewendet …`);
    try {
      await backend.ipProfileApply(nextRunId(), name);
    } catch (e) {
      setState({ busy: false });
      status(errorText(e), "error");
    }
  }

  // Countdown-Dialog „Verbindung ok?“ – bewusst eigenes Overlay, damit er sich
  // selbst schliessen kann (Backend entscheidet nach 30 s ohnehin selbst).
  let safety: { close(): void } | null = null;

  function openSafetyDialog(seconds: number, summary: string): void {
    safety?.close();
    let left = seconds;
    const counter = h("span", { class: "plain" });
    const renderCounter = () => (counter.textContent = left > 0 ? `${left} s` : "jetzt");
    renderCounter();
    const keepBtn = tbutton("Behalten", {
      onclick: () => {
        keepBtn.disabled = revertBtn.disabled = true;
        backend.ipProfileKeep().catch((e) => status(errorText(e), "error"));
      },
    });
    const revertBtn = tbutton("Jetzt zurücksetzen", {
      onclick: () => {
        keepBtn.disabled = revertBtn.disabled = true;
        backend.ipProfileRevert().catch((e) => status(errorText(e), "error"));
      },
    });
    const box = panel(
      "VERBINDUNG OK?",
      { cls: "dialog" },
      h("p", {}, "Neue Konfiguration ist aktiv:\n", h("span", { class: "plain" }, summary)),
      h("p", {}, "Ohne Bestätigung wird in ", counter, " automatisch die vorherige Konfiguration wiederhergestellt."),
      h("div", { class: "dialog-actions" }, revertBtn, keepBtn),
    );
    box.el.setAttribute("role", "alertdialog");
    box.el.setAttribute("aria-modal", "true");
    const backdrop = h("div", { class: "dialog-backdrop" }, box.el);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (!revertBtn.disabled) revertBtn.click();
      }
    };
    const timer = window.setInterval(() => {
      left = Math.max(0, left - 1);
      renderCounter();
      if (left === 0) keepBtn.disabled = revertBtn.disabled = true;
    }, 1000);
    document.addEventListener("keydown", onKey, true);
    document.body.append(backdrop);
    keepBtn.focus();
    safety = {
      close: () => {
        window.clearInterval(timer);
        document.removeEventListener("keydown", onKey, true);
        backdrop.remove();
        safety = null;
      },
    };
  }

  const finish = () => {
    setState({ busy: false });
    void refreshAll();
  };

  events.ipProfile.on((e: IpProfileEvent) => {
    switch (e.phase) {
      case "pending":
        void refreshAll(); // neue IP schon in der Übersicht zeigen
        openSafetyDialog(e.seconds ?? 30, e.message);
        status("Neue IP-Konfiguration aktiv – bitte bestätigen", "ok");
        break;
      case "kept":
        safety?.close();
        status(e.message, "ok");
        finish();
        break;
      case "reverting":
        safety?.close();
        status(e.message, e.ok ? "info" : "error");
        break;
      case "reverted":
        safety?.close();
        status(e.message, e.ok ? "ok" : "error");
        finish();
        if (!e.ok) {
          void confirmDialog({ title: "Bitte prüfen", message: e.message, confirmText: "Verstanden", infoOnly: true });
        }
        break;
      case "failed":
        safety?.close();
        status(e.message, "error");
        finish();
        break;
    }
  });

  // --- Verdrahtung ------------------------------------------------------------------

  for (const i of [nameIn, ipIn, subnetIn, gwIn, dns1In, dns2In]) {
    i.addEventListener("input", () => {
      touched = true;
      renderForm();
    });
    i.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void save();
    });
  }
  adapterSel.addEventListener("change", () => {
    if (adapterSel.value !== MISSING) missing = null;
    renderForm();
  });
  onStateChange(() => {
    renderAdapters();
    renderForm();
  });
  onConfigChange(() => {
    // Gespeichertes Profil weg (z. B. kaputte Datei)? Dann neues Formular.
    if (selected !== null && !savedProfile()) selected = null;
    // Beim Start kommt config.json erst nach dem Aufbau – dann das erste Profil zeigen
    if (!touched && selected === null && config().ipProfiles.length) return loadForm(config().ipProfiles[0], false);
    renderList();
    renderForm();
  });
  loadForm(config().ipProfiles[0] ?? null, false);

  return {
    el,
    applyByName: async (name: string) => {
      const p = config().ipProfiles.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
      if (!p) return status(`IP-Profil „${name}“ nicht gefunden.`, "error");
      loadForm(p);
      await apply();
    },
  };
}
