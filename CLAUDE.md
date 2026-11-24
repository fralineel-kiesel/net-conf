# CLAUDE.md – Projektkontext Net-Conf

## Ziel
Net-Conf ist ein Netzwerk-Helfer für den Arbeitsalltag unter **Windows 11 (x64)**.
Er zeigt die Infos von `ipconfig /all` als Karten und bietet Buttons für häufige
Netzwerk-Befehle. Look: modernes Terminal, aber mit Maus-Bedienung.
Der Entwickler ist Informatik-Lehrling (Systemtechnik), kein Rust-Profi:
Entscheidungen kurz erklären, nicht-offensichtlichen Code **auf Deutsch** kommentieren.

## Stack
- **Tauri v2** (Rust-Backend), Vite, **TypeScript ohne Framework** (kein React/Vue/Angular).
- Rust-Crates bewusst minimal: `tauri`, `serde`, `serde_json`, `windows-sys` (nur Windows).
- UI-Sprache: **Deutsch**.
- Ziel: kleine .exe, wenig RAM, Start < 1 s, keine unnötigen Abhängigkeiten.

## WICHTIG: Build & Test
- Claude läuft in einer Linux-Cloud-Umgebung und kann die App **nicht auf Windows starten**.
- Der echte Build läuft **nur in GitHub Actions** (`.github/workflows/build.yml`, `windows-latest`).
- Lokal prüfbar:
  - `npm run build` – Typecheck + Frontend-Build
  - `npm run dev` – UI im Browser mit Mock-Daten (`src/mock.ts`), `?admin=1` simuliert Adminrechte
  - `cd src-tauri && cargo test` – Rust-Tests (Validierung). Unter Linux braucht das `libwebkit2gtk-4.1-dev`.
  - `cd src-tauri && cargo clippy --target x86_64-pc-windows-msvc` – **typprüft den Windows-Code**
    (vorher `rustup target add x86_64-pc-windows-msvc`; Warnung „GNU compiler is not supported“ ist harmlos).
- `frontendDist` (`dist/`) muss existieren, bevor `cargo check` läuft → vorher `npm run build`.
- Fehlerlogs aus GitHub Actions fügt der Nutzer ein → beheben.

## Architektur
```
src-tauri/src/
  lib.rs       Tauri-Setup, Commands registrieren, Kindprozesse beim Beenden killen
  adapters.rs  Adapter via GetAdaptersAddresses + GetAdaptersInfo (Lease-Zeiten), Mock für Nicht-Windows
  runner.rs    Whitelist-Befehle (NetCommand), Validierung, Prozess-Start, Streaming, Abbruch
  system.rs    Hostname, Admin-Erkennung (Token-Elevation), Neustart via ShellExecuteW "runas"
src/
  main.ts      Layout, Navigation, Kopfzeile
  api.ts       Brücke zu Tauri – fällt auf mock.ts zurück, wenn keine Tauri-API da ist
  events.ts    Event-Verteiler (cmd-started / cmd-output / cmd-finished)
  commands.ts  startCommand(): runId vergeben, Ausgabe sammeln, Promise bis Ende
  ping.ts      sprachunabhängiger Ping-Parser + Statistik
  messages.ts  verständliche deutsche Fehlermeldungen
  views/       overview.ts, actions.ts, tests.ts
  ui/          dom.ts (h()-Helfer, Icons, Clipboard), console.ts, toast.ts, modal.ts, admin.ts
```

## Regeln (Sicherheit & Robustheit)
- **Nie** den Text von `ipconfig` parsen (sprachabhängig, Nutzer hat deutsches Windows) → Windows-API.
- Frontend schickt **keine Befehlszeilen**, nur `NetCommand`-Objekte (Whitelist in `runner.rs`).
  Programm-Pfade (`%SystemRoot%\System32\…`) und Argumente baut nur das Backend. Keine Shell dazwischen.
- Freie Eingaben (Ping-Ziel, Adaptername) streng validieren; Ziel darf nicht mit `-` beginnen.
  Frontend-Validierung (`src/validate.ts`) ist nur Komfort – das Backend entscheidet.
- Prozesse mit `CREATE_NO_WINDOW` starten; Ausgabe mit OEM-Codepage dekodieren
  (`MultiByteToWideChar(CP_OEMCP)` – `encoding_rs` kennt cp850 nicht).
- Windows-spezifischen Code mit `#[cfg(windows)]` kapseln, für andere Systeme einfachen Fallback.
- Die runId vergibt das Frontend, damit Events schon vor der invoke-Antwort zugeordnet werden können.
- Konservativ coden: lieber einfach und sicher kompilierend als clever.

## Design-Regeln
- Dunkler Hintergrund (`--bg: #0a0d12`), **ein** Akzent: Cyan `#22d3ee`. Status: grün `#34d399`, grau.
- Schrift: `Cascadia Mono` → `Consolas` → monospace. **Keine Web-Fonts** (offline!).
- Abgerundete Karten, dezente Hover-/Glow-Effekte, Animationen **< 200 ms**, nicht überladen.
- Farben nur über CSS-Variablen in `src/styles.css`.
- Mindestfenster 900×600 muss gut aussehen.

## Konventionen
- Commits: klein, englisch, sprechend (z. B. „Add ping sparkline“). Branch der Session nutzen, PR macht der Nutzer.
- Code-Kommentare und UI-Texte: Deutsch. Bezeichner im Code: Englisch.
- Neue Tauri-Commands: in `lib.rs` im `generate_handler!` registrieren und in `src/api.ts` + `src/mock.ts` ergänzen.
- Version an drei Stellen pflegen: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`.
- Release: Tag `v*` pushen → Workflow erstellt GitHub Release.

## Phasenplan
- **Phase 1 (fertig):** Grundgerüst, Adapter-Übersicht, ipconfig-Aktionen, Ping, Konsole, Admin-Erkennung, CI.
- **Phase 2 (Ideen, noch NICHT bauen ohne Auftrag):**
  - Traceroute (`tracert`) mit Hop-Liste
  - DNS-Abfrage (`nslookup` bzw. Windows-DNS-API) mit Record-Typen
  - Port-Test (TCP-Connect zu Host:Port)
  - Öffentliche IP anzeigen
  - ARP-Tabelle und Routing-Tabelle
  - WLAN-Infos (SSID, Signal, Kanal, Band)
  - Einstellungen (Akzentfarbe, Standard-Ping-Ziel, Konsole-Höhe, Autostart-Ansicht)
