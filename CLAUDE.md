# CLAUDE.md – Projektkontext Net-Conf

## Ziel
Net-Conf ist ein Netzwerk-Helfer für den Arbeitsalltag unter **Windows 11 (x64)**.
Er zeigt die Infos von `ipconfig /all` als Panels, bietet Buttons für häufige
Netzwerk-Befehle und Diagnose-Werkzeuge (Ping, Traceroute, DNS, Port-Test,
Health-Check, Ping-Monitor, ARP/Routen, WLAN, LAN-Scanner, Wake-on-LAN). Look: TUI wie htop/btop, aber mit Maus-Bedienung.
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
  - `npm test` – Tests der Ping-Graph-Skala und der Health-Check-Bewertung
    (`scripts/pingscale.test.ts`, `scripts/health.test.ts`, Node ≥ 22, ohne Test-Framework).
    Importe zwischen Modulen, die Node laden soll, mit `.ts`-Endung schreiben (z. B. `health.ts` → `./netutil.ts`).
  - `npm run dev` – UI im Browser mit Mock-Daten (`src/mock.ts` + `src/mock-diag.ts`), `?admin=1` simuliert Adminrechte,
    `?fail=renew` lässt jeden Aktions-Schritt scheitern, dessen Befehl „renew“ enthält (Fehlerpfad testen),
    `?net=offline|apipa|nogateway|dnsfail|noicmp` spielt Fehlerfälle für den Health-Check durch.
  - `cd src-tauri && cargo test` – Rust-Tests (Validierung, Aktions-Abläufe, DNS-Parser, Port-Test, config.json,
    Monitor-Logik, Subnetz-Regeln, MAC/Magic Packet). Unter Linux braucht das `libwebkit2gtk-4.1-dev`.
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
  runner.rs    Ablauf-Executor (Schritte: Prozess/Warten), Ping/Tracert (NetCommand), Validierung,
               Prozess-Start, Streaming, Abbruch
  actions.rs   Whitelist der Aktionen (ActionId → feste Befehle/Abläufe), Adapter-Abgleich
  system.rs    Hostname, Admin-Erkennung (Token-Elevation), Neustart via ShellExecuteW "runas"
  dns.rs       eigener kleiner DNS-Client über UDP (wie nslookup), reines Rust, ohne unsafe
  porttest.rs  TCP-Connect-Test, parallel pro Port (offen/geschlossen/gefiltert)
  tables.rs    ARP (GetIpNetTable2) und Routen (GetIpForwardTable2)
  wifi.rs      WLAN über wlanapi.dll (SSID, Signal, Kanal, Band, Sicherheit)
  icmp.rs      native Pings (IcmpSendEcho, ohne ping.exe/Admin), Resolver mit Zeitlimit, parallel_map
  config.rs    config.json in %APPDATA%\Net-Conf (Monitor-Ziele, WoL-Geräte), atomar, .bak bei Defekt
  monitor.rs   Ping-Monitor im Backend-Thread (Stats, DOWN nach 2 Timeouts, Ausfall-Log, Events)
  lan.rs       LAN-Scanner (SendARP, nur eigenes privates Subnetz ≤ /22), Subnetz-Regeln
  wol.rs       Wake-on-LAN: MAC-Parser, Magic Packet, Broadcast über den gewählten Adapter
src/
  main.ts      Layout, Navigation, Kopfzeile
  api.ts       Brücke zu Tauri – fällt auf mock.ts zurück, wenn keine Tauri-API da ist
  events.ts    Event-Verteiler (cmd-*, monitor-update, lan-host/-progress/-finished)
  commands.ts  startCommand()/startAction(): runId vergeben, Ausgabe sammeln, Promise bis Ende
  actions.ts   Anzeige-Daten der Aktionen (Titel, Schritte, Tags, Bestätigungstexte) – auch für den Mock
  ping.ts      sprachunabhängiger Ping-Parser + Statistik
  pingscale.ts Skala des Ping-Graphen (schöne Stufen + Hysterese)
  tracert.ts   sprachunabhängiger Traceroute-Parser (Hop-Zeilen: Nummer, 3× ms/*, Host)
  messages.ts  verständliche deutsche Fehlermeldungen
  settings.ts  Einstellungen (localStorage) + applySettings() → CSS-Variablen
  config.ts    Kopie von config.json im Frontend (loadConfig/updateConfig → Backend prüft + speichert)
  health.ts    Health-Check: Ablauf (Fakten sammeln) + reine Bewertung evaluate()/diagnose() (getestet)
  netutil.ts   reine IPv4-/Adapter-Helfer (primaryOf, maskToPrefix, scanBlockReason, normalizeMac …)
  nav.ts       Sprünge zwischen Ansichten ohne Import-Schleifen (z. B. LAN-Scanner → Ping-Test)
  views/       overview.ts (ASCII-Titel, SYSTEM, öffentliche IP, WLAN), actions.ts, tables.ts, settings.ts,
               lan.ts (Scanner + Wake-on-LAN), tests.ts (Reiter) + tests/ping.ts, tracert.ts, dns.ts,
               port.ts, health.ts, monitor.ts
  ui/          dom.ts (h()-Helfer, Logo, Clipboard), widgets.ts (TUI-Bausteine),
               statusbar.ts (Rückmeldungen statt Toasts), console.ts, modal.ts,
               latencygraph.ts (Ping-Graph auf Canvas, `mini: true` = 1 Zeile für den Monitor), admin.ts
assets/logo.svg  Quelle des Logos (Icons + Inline-SVG in der Kopfzeile)
assets/title.txt ASCII-Titel der Übersicht (erzeugt von scripts/make-title.py)
```

## Regeln (Sicherheit & Robustheit)
- **Nie** den Text von `ipconfig` parsen (sprachabhängig, Nutzer hat deutsches Windows) → Windows-API.
- Frontend schickt **keine Befehlszeilen**, nur `NetCommand`-Objekte (Ping/Tracert, `runner.rs`)
  oder eine **Aktions-ID** (`actions.rs`, siehe unten).
  Programm-Pfade (`%SystemRoot%\System32\…`) und Argumente baut nur das Backend. Keine Shell dazwischen.
- Freie Eingaben (Ping-Ziel, Adaptername) streng validieren; Ziel darf nicht mit `-` beginnen.
  Adapternamen nur akzeptieren, wenn sie **exakt** in der aktuellen Adapterliste vorkommen.
  Ping-Anzahl nur aus `PING_COUNTS` (2, 4, 8, 16, 32) oder `null` = `ping -t`.
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
- Viele kurze Pings (Health, Monitor, Scan, WoL-Check) **nur über `icmp.rs`** (IcmpSendEcho), nie ping.exe.
  Der Ping-Test (Tests → Ping) bleibt bei ping.exe, damit man dort die echte Windows-Ausgabe sieht.
- Parallelität immer begrenzen (`icmp::parallel_map`): Scan 64, Monitor ≤ 20 (= max. Ziele).
- Dauerhafte Daten, die das Backend kennen muss (Monitor-Ziele, WoL-Geräte), in `config.json` über
  `config.rs` – nie direkt schreiben. Beim Speichern streng prüfen, beim Laden Ungültiges verwerfen.
  Reine Anzeige-Einstellungen bleiben im localStorage (`settings.ts`).

### Sicherheitsregeln LAN-Scan und Wake-on-LAN
- **Kein frei wählbarer IP-Bereich.** Das Frontend schickt nur Adaptername + eigene IPv4-Adresse;
  das Backend prüft, dass beides exakt in der aktuellen Adapterliste steht und berechnet das Subnetz selbst.
- Gescannt werden nur private Netze (RFC 1918: 10/8, 172.16/12, 192.168/16) und Link-Local (169.254/16),
  höchstens **/22** (1022 Adressen). Regel steht in `lan::scan_range` (mit Tests) und gespiegelt in
  `netutil.scanBlockReason` (nur Anzeige).
- Es läuft immer nur ein Scan; Abbruch über `lan_scan_cancel`, beim Beenden der App automatisch.
- Fester Hinweis im Panel: „Nur im eigenen bzw. erlaubten Netz verwenden.“
- WoL: MAC im Backend prüfen (`wol::parse_mac`, Formate `AA-BB-…`, `AA:BB:…`, `AABB…`, kein Multicast/00/FF),
  gesendet wird nur per Broadcast über einen echten Adapter (Socket an dessen IP gebunden):
  an die Subnetz-Broadcast-Adresse und an 255.255.255.255, UDP-Port 9.

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
- `choice()` – Auswahl als Reihe `[2] [4] [8] [∞]`, gewählte Option invertiert.
  Deaktiviert = gedimmt + `[x]`, ohne Adminrechte = gedimmt + `(Admin nötig)`.
- `checkbox()` – `[x] Label` / `[ ] Label`; `radio()` – `(*) A  ( ) B`.
- `kvRow()` – `Label . . . . : Wert` (Punkte-Füller per CSS, Label-Spalte 18ch).
- `prompt()` – Überschrift im Prompt-Stil `$ ipconfig /all █`.
- `tag()` – Status als Text in eckigen Klammern: `[ONLINE]`, `[OFFLINE]`, `[DHCP]`, `[STATISCH]`, `[PRIMÄR]`,
  `[ADMIN]`, `[USER]`, `[!]` (unterbricht/ändert das Netz, rot).
- `tabs()` – Reiter `[Ping]  Traceroute  DNS` (aktiv/inaktiv gleich breit).
- `table()` – Text-Tabelle mit ausgerichteten Spalten (Kopfzeile gedimmt, GROSS).
- `copyable()` – Wert, der sich per Klick kopiert; `bar()` – Balken `██████░░░░`.
- Rückmeldungen (z. B. `kopiert: <Wert>`, Fehler) über `status()` in die Statusleiste – keine Toasts.

Layout:
- Kopfzeile: eine Textzeile `[Logo] net-conf @ HOST … [ADMIN]|[USER] [ Neu laden ] (F5)`.
- Seitenleiste: Textmenü mit `>`-Marker und Tastenkürzeln (siehe Seitenübersicht unten).
- Hauptbereich, darunter Konsole (gleiches Panel-Design), ganz unten Statusleiste (wie vim/tmux).
- Schrift: `Cascadia Mono` → `Consolas` → monospace, **13px** überall. **Keine Web-Fonts** (offline!).
- Mindestfenster 900×600 muss gut aussehen (Adapter-Panels zweispaltig).
- Prüfen: Screenshots im Mock-Modus + Audit, das per `getComputedStyle` Rundungen,
  Schatten, Verläufe, Transitions und Grün/Rot als Rahmen/Hintergrund sucht.

## Seitenübersicht (Tasten)
| Taste | Seite | Inhalt |
|---|---|---|
| F1 | Übersicht | ASCII-Titel, SYSTEM, öffentliche IP, ein Panel pro Adapter (+ WLAN) |
| F2 | Aktionen | ipconfig/arp/nbtstat/netsh-Aktionen aus der Whitelist |
| F3 | Tests | Reiter Ping · Traceroute · DNS · Port · Health · Monitor (nochmal F3 = nächster Reiter) |
| F4 | Tabellen | ARP- und Routing-Tabelle |
| F5 | – | Neu laden |
| F6 | LAN | Reiter Scanner · Wake-on-LAN (nochmal F6 = nächster Reiter) |
| F7 | *(reserviert)* | WLAN |
| F8 | *(reserviert)* | Traffic |
| F9 | *(reserviert)* | Werkzeuge |
| F10 | Einstellungen | Akzentfarbe, Ping-Ziel, Konsole, Start-Ansicht, Speicherorte |

Neue Seite: `ViewId` in `settings.ts`, `NAV` + `views` in `main.ts`, `START_VIEWS` in `views/settings.ts`.

## Diagnose (Phase 4a)
- **Health-Check** (Tests → Health): 6 Stufen nacheinander – Adapter mit Gateway, IPv4 ohne APIPA,
  Gateway-Ping, Ping jedes IPv4-DNS-Servers, Auflösung von example.com über den System-Resolver
  (Zeitlimit 3 s, `resolve_name`), Ping 1.1.1.1 (Fallback 8.8.8.8). Status `[OK]` `[WARNUNG]` `[FEHLER]`
  `[ÜBERSPRUNGEN]` mit Wert und deutschem Hinweis, Abschlusszeile „Diagnose: …“, [ Kopieren ].
  Fehlende Pings werden erst am Ende bewertet: klappen Auflösung/Internet, ist es nur [WARNUNG] (ICMP blockiert).
  Hinweis: Der Windows-DNS-Cache kann example.com auch bei kaputtem DNS noch beantworten.
- **Ping-Monitor** (Tests → Monitor): max. 20 Ziele, Intervall 1/2/5/10 s, läuft im Backend-Thread weiter.
  DOWN erst nach **2** Timeouts in Folge, UP bei der nächsten Antwort. Ausfall-Log max. 500 Einträge.
  Statusleiste zeigt „Monitor: N Ziele, M DOWN“, solange er läuft. Ziele + Intervall in config.json;
  `monitor_set` behält die Statistik unveränderter Ziele (Schlüssel Name + Host), `monitor_start` setzt sie zurück.
- **LAN-Scanner** (LAN → Scanner): SendARP auf jede Adresse (64 parallel; SendARP hat kein Zeitlimit,
  leere Adressen dauern ~1–3 s), danach für gefundene Geräte ICMP (500 ms) und PTR beim ersten
  IPv4-DNS-Server des Adapters (1 s, `dns::reverse_lookup`). Ergebnis kommt als `lan-host`-Events
  (pro Gerät zweimal: erst MAC, dann Latenz/Name). Eigene IP = MAC aus der Adapterliste.
- **Wake-on-LAN** (LAN → Wake-on-LAN): Geräteliste in config.json, nach dem Senden Ping-Check alle 2 s
  für max. 60 s (nur wenn IP bekannt). „Gesendet“ heisst nicht „aufgewacht“ – steht so im Panel.

## Aktionen (F2) – Whitelist über Aktions-IDs
Das Frontend schickt nur `run_action(runId, action, adapter)`. Programme (immer `%SystemRoot%\System32\…`),
Argumente und Reihenfolge stehen ausschliesslich in `src-tauri/src/actions.rs`. `src/actions.ts` enthält
nur Anzeige-Daten (und dient dem Mock) – bei Änderungen **beide** Dateien anpassen.

| Panel | ID | Ablauf | Tags |
|---|---|---|---|
| IP / DHCP | `release` | `ipconfig /release [Adapter]` | [ADMIN] [!] |
| | `renew` | `ipconfig /renew [Adapter]` | [ADMIN] |
| | `releaseRenew` | release → warten 2 s → renew | [ADMIN] [!] |
| | `fullRefresh` | flushdns → release → warten 2 s → renew → registerdns | [ADMIN] [!] |
| DNS | `flushDns` | `ipconfig /flushdns` | – |
| | `displayDns` | `ipconfig /displaydns` | – |
| | `registerDns` | `ipconfig /registerdns` | [ADMIN] |
| | `dnsRefresh` | flushdns → registerdns | [ADMIN] |
| Cache & Namen | `arpClear` | `arp -d *` | [ADMIN] |
| | `nbtPurge` | `nbtstat -R` | [ADMIN] |
| | `nbtReregister` | `nbtstat -RR` | [ADMIN] |
| Adapter | `adapterRestart` | `netsh interface set interface "<Name>" admin=disabled` → 3 s → `admin=enabled` (nur mit Adapter) | [ADMIN] [!] |
| Reparatur | `winsockReset` | `netsh winsock reset` (danach Neustart) | [ADMIN] [!] |
| | `tcpipReset` | `netsh int ip reset` (danach Neustart) | [ADMIN] [!] |

Regeln:
- Adapter: `release/renew/releaseRenew/fullRefresh` optional (ohne = alle), `adapterRestart` Pflicht,
  alle anderen lehnen einen Adapter ab. Der Name ist immer ein **eigenes Argument**.
- netsh mit Positionsform (`set interface "<Name>" admin=…`), nicht `name="…"`: Rust quotet nur ganze
  Argumente; Anführungszeichen mitten im Argument würden als `\"` maskiert.
- Abläufe: Scheitert ein Schritt oder wird abgebrochen, laufen die restlichen Schritte nicht –
  **ausser** `restore`-Schritten (renew, Adapter aktivieren), wenn vorher ein `disruptive`-Schritt
  (release, deaktivieren) lief. Sonst stünde man ohne Netz da. Logik: `execute_steps` (mit Tests).
- Events: `cmd-step` liefert Schrittmarker (`[1/3] ipconfig /release`), `cmd-finished` zusätzlich
  `failedStep` (1-basiert) und `error`. Fehlermeldung nennt den Schritt, ausgewertet wird nur dessen Ausgabe.
- [!]-Aktionen immer mit `confirmDialog({ danger: true })`. Nach IP-ändernden Aktionen `refreshAll()`.
  Reparatur-Aktionen zeigen nach Erfolg „Neustart erforderlich“ (Dialog + Hinweis im Panel).
- Vor neuen Aktionen prüfen, ob es sie schon gibt (z. B. Tabellen F4 zeigt ARP nur an).

## Ping-Graph (Skala)
- Balken proportional ab **0 ms** (fester Nullpunkt, nie ab dem Minimum). Jede Antwort mind. 1 Stufe hoch.
- Obergrenze = nächste Stufe aus `[10, 20, 50, 100, 200, 500, 1000]` ms über dem Maximum der
  **sichtbaren** Werte, mindestens 10 ms (über 1000: volle Sekunden).
- Hysterese: wächst **sofort**; schrumpft erst, wenn das Maximum über **10 Messungen** in Folge
  ≤ 80 % einer kleineren Stufe lag (`pingscale.ts`, Test: `npm test`).
- 3 Textzeilen hoch = 24 Stufen, gezeichnet auf Canvas (keine Zeilenlücken), 1 Spalte = 1 Zeichen breit,
  neueste Messung rechts. Zeitüberschreitung = rotes `×` auf der Grundlinie. Skala steht rechts daneben.
- Die Statistik (gesendet/empfangen/Verlust, min/avg/max) wird nie geglättet.

## ASCII-Titel (Übersicht)
- Datei `assets/title.txt` (figlet-Font „slant“, 50×5 Zeichen). Neu erzeugen (nur Entwicklungswerkzeug):
  `pip install pyfiglet` und `python scripts/make-title.py` (prüft max. 60×7).
- Einbinden per `import … from "../../assets/title.txt?raw"` und `textContent` in ein `<pre>` –
  **nie** als JS-String-Literal (Backslashes!) und nie per `innerHTML`. `.gitattributes` erzwingt LF.
- Unter 56 Zeichen Breite (Container-Query) einzeilig `[ NET-CONF ]`. Farbe `--bright`, kein Akzent.
- Untertitel mit `__APP_VERSION__` (liest `vite.config.ts` aus `package.json`).

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
- **Phase 3 (fertig, v0.3.0):** ASCII-Titel + SYSTEM-Panel, primärer Adapter zuerst, Aktionen in Panels
  mit Abläufen (Release + Renew u. a.), Ping-Anzahl wählbar, ruhiger Ping-Graph.
- **Phase 4a (fertig, v0.4.0):** ICMP-Modul (IcmpSendEcho), config.json-Persistenz, Health-Check,
  Ping-Monitor im Hintergrund, LAN-Scanner (F6) mit Reverse-DNS, Wake-on-LAN mit Ping-Check.
- **Ideen für später (NICHT bauen ohne Auftrag):**
  - F7 WLAN: WLAN-Umgebung scannen (alle Netze mit Kanal/Signal, Kanalbelegung als Blockgrafik)
  - F8 Traffic, F9 Werkzeuge (Inhalt noch offen)
  - Hersteller zur MAC (OUI) im LAN-Scanner: nur mit kompakter eingebetteter Tabelle (< 300 KB);
    die volle IEEE-Liste ist deutlich grösser – daher in 4a weggelassen
  - IPv6 im ICMP-Modul (Icmp6SendEcho2) für Monitor/Health
  - Speed-/Latenz-Langzeitmessung mit Export (CSV)
  - DNS-Server/IP per Klick setzen (netsh, braucht Admin)
  - Ergebnisse als Text für Tickets exportieren
