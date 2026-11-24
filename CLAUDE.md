# CLAUDE.md – Projektkontext Net-Conf

## Ziel
Net-Conf ist ein Netzwerk-Helfer für den Arbeitsalltag unter **Windows 11 (x64)**.
Er zeigt die Infos von `ipconfig /all` als Panels, bietet Buttons für häufige
Netzwerk-Befehle und Diagnose-Werkzeuge (Ping, Traceroute, DNS, Port-Test,
ARP/Routen, WLAN). Look: TUI wie htop/btop, aber mit Maus-Bedienung.
Der Entwickler ist Informatik-Lehrling (Systemtechnik), kein Rust-Profi:
Entscheidungen kurz erklären, nicht-offensichtlichen Code **auf Deutsch** kommentieren.

## Stack
- **Tauri v2** (Rust-Backend), Vite, **TypeScript ohne Framework** (kein React/Vue/Angular).
- Rust-Crates bewusst minimal: `tauri`, `serde`, `serde_json`, `windows-sys` (nur Windows).
  Kein HTTP-/TLS-Crate: HTTPS-Abfragen (öffentliche IP) macht das WebView per `fetch`.
- UI-Sprache: **Deutsch**.
- Ziel: kleine .exe, wenig RAM, Start < 1 s, keine unnötigen Abhängigkeiten.

## WICHTIG: Build & Test
- Claude läuft in einer Linux-Cloud-Umgebung und kann die App **nicht auf Windows starten**.
- Der echte Build läuft **nur in GitHub Actions** (`.github/workflows/build.yml`, `windows-latest`).
- Lokal prüfbar:
  - `npm run build` – Typecheck + Frontend-Build
  - `npm run dev` – UI im Browser mit Mock-Daten (`src/mock.ts`), `?admin=1` simuliert Adminrechte
  - `cd src-tauri && cargo test` – Rust-Tests (Validierung, DNS-Parser, Port-Test). Unter Linux braucht das `libwebkit2gtk-4.1-dev`.
    `cargo test -- --ignored` macht zusätzlich echte DNS-Abfragen (braucht Netz; in der Cloud-Sandbox
    werden nur freigegebene Hosts wie github.com aufgelöst).
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
  dns.rs       eigener kleiner DNS-Client über UDP (wie nslookup), reines Rust, ohne unsafe
  porttest.rs  TCP-Connect-Test, parallel pro Port (offen/geschlossen/gefiltert)
  tables.rs    ARP (GetIpNetTable2) und Routen (GetIpForwardTable2)
  wifi.rs      WLAN über wlanapi.dll (SSID, Signal, Kanal, Band, Sicherheit)
src/
  main.ts      Layout, Navigation, Kopfzeile
  api.ts       Brücke zu Tauri – fällt auf mock.ts zurück, wenn keine Tauri-API da ist
  events.ts    Event-Verteiler (cmd-started / cmd-output / cmd-finished)
  commands.ts  startCommand(): runId vergeben, Ausgabe sammeln, Promise bis Ende
  ping.ts      sprachunabhängiger Ping-Parser + Statistik
  tracert.ts   sprachunabhängiger Traceroute-Parser (Hop-Zeilen: Nummer, 3× ms/*, Host)
  messages.ts  verständliche deutsche Fehlermeldungen
  settings.ts  Einstellungen (localStorage) + applySettings() → CSS-Variablen
  views/       overview.ts (inkl. öffentliche IP, WLAN), actions.ts, tables.ts, settings.ts,
               tests.ts (Reiter) + tests/ping.ts, tracert.ts, dns.ts, port.ts
  ui/          dom.ts (h()-Helfer, Logo, Clipboard), widgets.ts (TUI-Bausteine),
               statusbar.ts (Rückmeldungen statt Toasts), console.ts, modal.ts,
               blockgraph.ts (Latenz-Graph aus Blockzeichen), admin.ts
assets/logo.svg  Quelle des Logos (Icons + Inline-SVG in der Kopfzeile)
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
- Blockierende Backend-Arbeit (DNS, Port-Test, Tabellen, WLAN) läuft über `spawn_blocking`.
- C-Arrays variabler Länge (`Table: [ROW; 1]`) über `addr_of!` vom Rohzeiger lesen,
  nicht über eine Referenz; Speicher immer freigeben (FreeMibTable, WlanFreeMemory, Drop-Guards).
- Werkzeuge ohne eigenen Prozess protokollieren ihr Ergebnis mit `logToConsole()` in der Konsole.
- Externe Dienste nie automatisch kontaktieren – die öffentliche IP (ipify.org) nur auf Klick.
  Neue externe Hosts müssen in die CSP (`connect-src` in `tauri.conf.json`).
- WLAN ab Windows 11 24H2: SSID/BSSID nur mit Standortzugriff für Desktop-Apps →
  verständlicher Hinweis statt Fehlercode (`wifi::LOCATION_HINT`).
- Konservativ coden: lieber einfach und sicher kompilierend als clever.

## Design-Regeln: TUI-Look (wie htop, btop, lazygit)
Die App soll wie eine Terminal-Oberfläche wirken, bleibt aber per Maus bedienbar.
**Kein** „KI-Webseiten-Look“ (runde Karten, Glow, Pillen, Punkte, Toggle-Schalter).

Verboten:
- `border-radius` (überall 0), `box-shadow`, `text-shadow`, Glow, `filter`, Verläufe.
- Transitions und Animationen – ein Terminal reagiert sofort.
  **Einzige Ausnahme:** der blinkende Block-Cursor `.cursor` (hart an/aus, `steps(1)`).
- Pillen-Badges, Toggle-Schalter, Toasts, Web-App-Icons, Status-Punkte.
- Fettdruck, mehrere Schriftgrössen, Letter-Spacing.

Farben (nur über CSS-Variablen in `src/styles.css`):
- Hintergrund fast schwarz `--bg #0b0e12`, Schrift hellgrau `--text`.
- Labels gedimmt `--dim`, Werte/Titel hell `--bright`.
- **Eine** Akzentfarbe, Standard Cyan `--accent #22d3ee` – NUR für Interaktives (Hover, Fokus, aktiver Menüpunkt, Auswahl).
  In den Einstellungen wählbar (Cyan, Bernstein, Magenta, Blau, Weiss) – **nie Grün/Rot**. Das Logo bleibt immer Cyan.
- Grün `--ok` / Rot `--err` NUR als **Textfarbe für Status-Wörter** (`.tag-ok`, `.tag-err`), nie als Punkt, Linie, Rahmen oder Hintergrund.
- Linien: 1px dunkelgrau `--line`. Statusleiste etwas heller (`--bar`).

Bausteine (`src/ui/widgets.ts`) – immer diese verwenden:
- `panel()` – eckiger Kasten, Titel sitzt IN der oberen Linie (links Titel, rechts z. B. `[ONLINE] [DHCP]`).
- `tbutton()` – `[ Text ]`; Hover/Fokus = Farben invertieren (Cyan-Hintergrund, dunkle Schrift).
  Deaktiviert = gedimmt + `[x]`, ohne Adminrechte = gedimmt + `(Admin nötig)`.
- `checkbox()` – `[x] Label` / `[ ] Label`; `radio()` – `(*) A  ( ) B`.
- `kvRow()` – `Label . . . . : Wert` (Punkte-Füller per CSS, Label-Spalte 18ch).
- `prompt()` – Überschrift im Prompt-Stil `$ ipconfig /all █`.
- `tag()` – Status als Text in eckigen Klammern: `[ONLINE]`, `[OFFLINE]`, `[DHCP]`, `[STATISCH]`, `[ADMIN]`, `[USER]`.
- `tabs()` – Reiter `[Ping]  Traceroute  DNS` (aktiv/inaktiv gleich breit).
- `table()` – Text-Tabelle mit ausgerichteten Spalten (Kopfzeile gedimmt, GROSS).
- `copyable()` – Wert, der sich per Klick kopiert; `bar()` – Balken `██████░░░░`.
- Rückmeldungen (z. B. `kopiert: <Wert>`, Fehler) über `status()` in die Statusleiste – keine Toasts.

Layout:
- Kopfzeile: eine Textzeile `[Logo] net-conf @ HOST … [ADMIN]|[USER] [ Neu laden ] (F5)`.
- Seitenleiste: Textmenü mit `>`-Marker, Tastenkürzel F1 Übersicht, F2 Aktionen,
  F3 Tests (nochmal F3 = nächster Reiter), F4 Tabellen, F10 Einstellungen; F5 = Neu laden.
- Hauptbereich, darunter Konsole (gleiches Panel-Design), ganz unten Statusleiste (wie vim/tmux).
- Schrift: `Cascadia Mono` → `Consolas` → monospace, **13px** überall. **Keine Web-Fonts** (offline!).
- Mindestfenster 900×600 muss gut aussehen (Adapter-Panels zweispaltig).
- Prüfen: Screenshots im Mock-Modus + Audit, das per `getComputedStyle` Rundungen,
  Schatten, Verläufe, Transitions und Grün/Rot als Rahmen/Hintergrund sucht.

## Logo
- Konzept: **Netzwerk-Topologie** – ein zentraler Knoten, verbunden mit drei äusseren
  Knoten (oben links, oben rechts, unten) durch gerade, dicke Linien.
- Alle Knoten sind **Quadrate** (Pixel-Look), gefüllt. Cyan `#22D3EE` auf `#0B0E12`.
- Hintergrund: Quadrat mit minimaler Rundung (rx 80 von 1024 ≈ 8 %). Kein Glow, kein Verlauf, kein heller Rand.
- Muss bei 16×16 und 32×32 lesbar bleiben → wenige Elemente, viel Abstand.
- Quelle: `assets/logo.svg`. Icons neu erzeugen **direkt aus dem SVG**
  (`npx tauri icon assets/logo.svg -o src-tauri/icons`, danach `android/` und `ios/` löschen) –
  das Herunterskalieren eines PNG erzeugt dunkle Ränder bei 16/32 px.
  `app-icon.png` ist nur eine 1024er-Vorschau.
- Die Kopfzeile bindet dasselbe SVG per `?raw`-Import inline ein.

## Konventionen
- Commits: klein, englisch, sprechend (z. B. „Add ping sparkline“). Branch der Session nutzen, PR macht der Nutzer.
- Code-Kommentare und UI-Texte: Deutsch. Bezeichner im Code: Englisch.
- Neue Tauri-Commands: in `lib.rs` im `generate_handler!` registrieren und in `src/api.ts` + `src/mock.ts` ergänzen.
- Version an drei Stellen pflegen: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`.
- Release: Tag `v*` pushen → Workflow erstellt GitHub Release.

## Phasenplan
- **Phase 1 (fertig):** Grundgerüst, Adapter-Übersicht, ipconfig-Aktionen, Ping, Konsole, Admin-Erkennung, CI.
- **Phase 1.5 (fertig):** Design-Umbau auf TUI-Look, neues Netzwerk-Logo. Funktionen unverändert.
- **Phase 2 (fertig, v0.2.0):** Traceroute, DNS-Abfrage, Port-Test, öffentliche IP, ARP-/Routing-Tabelle,
  WLAN-Infos, Einstellungen.
- **Ideen für später (NICHT bauen ohne Auftrag):**
  - WLAN-Umgebung scannen (alle Netze mit Kanal/Signal, Kanalbelegung als Blockgrafik)
  - Netzwerk-Scan im eigenen Subnetz (Ping-Sweep, ARP)
  - Speed-/Latenz-Langzeitmessung mit Export (CSV)
  - DNS-Server/IP per Klick setzen (netsh, braucht Admin)
  - Ergebnisse als Text für Tickets exportieren
