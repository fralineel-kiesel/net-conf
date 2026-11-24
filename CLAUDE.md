# CLAUDE.md – Projektkontext Net-Conf

## Ziel
Net-Conf ist ein Netzwerk-Helfer für den Arbeitsalltag unter **Windows 11 (x64)**.
Er zeigt die Infos von `ipconfig /all` als Panels, bietet Buttons für häufige
Netzwerk-Befehle und Diagnose-Werkzeuge (Ping, Traceroute, DNS, Port-Test,
Health-Check, Ping-Monitor, ARP/Routen, WLAN-Verwaltung, LAN-Scanner, Wake-on-LAN, Live-Traffic,
Verbindungen/Prozesse, Subnetz-Rechner, IP-Profile), dazu Befehlspalette (Strg+K), Themes,
Tray/Kompaktmodus und Update-Hinweis. Look: TUI wie htop/btop, aber mit Maus-Bedienung.
Der Entwickler ist Informatik-Lehrling (Systemtechnik), kein Rust-Profi:
Entscheidungen kurz erklären, nicht-offensichtlichen Code **auf Deutsch** kommentieren.

## Stack
- **Tauri v2** (Rust-Backend), Vite, **TypeScript ohne Framework** (kein React/Vue/Angular).
- Rust-Crates bewusst minimal: `tauri` (Feature `tray-icon`), `serde`, `serde_json`, `windows-sys` (nur Windows).
  Kein HTTP-/TLS-Crate: HTTPS-Abfragen (öffentliche IP, Update-Check) macht das WebView per `fetch`.
  Kein Opener-/Autostart-Plugin: Browser öffnen (ShellExecuteW) und Registry (`winreg.rs`) über windows-sys.
- Frontend-Abhängigkeiten: `@tauri-apps/api`; als devDependencies nur Build-Werkzeuge und fünf Schrift-Pakete
  `@fontsource/*` (JetBrains Mono, IBM Plex Mono, Space Mono, VT323, Share Tech Mono – Lizenz SIL OFL 1.1),
  von denen nur je **eine** woff2-Datei (latin, 400) in die App kommt (`src/fonts.ts`, zusammen ca. 84 KB).
- UI-Sprache: **Deutsch**.
- Ziel: kleine .exe, wenig RAM, Start < 1 s, keine unnötigen Abhängigkeiten.

## WICHTIG: Build & Test
- Claude läuft in einer Linux-Cloud-Umgebung und kann die App **nicht auf Windows starten**.
- Der echte Build läuft **nur in GitHub Actions** (`.github/workflows/build.yml`, `windows-latest`).
- Lokal prüfbar:
  - `npm run build` – Typecheck + Frontend-Build
  - `npm test` – Tests der Graph-Skalen (Ping + Traffic), der Health-Check-Bewertung, der Phase-4b-Helfer,
    des Subnetz-Rechners, der Theme-Kontraste, der Fuzzy-Suche, des Update-Vergleichs, der Tastenkürzel und der
    Einstellungs-Prüfung/Export/Import (`scripts/*.test.ts`, Node ≥ 22, ohne Test-Framework).
  - `npm run e2e` – Ende-zu-Ende-Test der Einstellungen im Browser-Mock (`scripts/e2e/settings.e2e.cjs`,
    braucht laufendes `npm run dev` und Playwright – in der Cloud vorinstalliert, bewusst keine Projekt-Abhängigkeit).
    Kein `constructor(private x)` in Modulen, die Node lädt (Strip-Modus kennt keine Parameter Properties).
    Importe zwischen Modulen, die Node laden soll, mit `.ts`-Endung schreiben (z. B. `health.ts` → `./netutil.ts`).
  - `npm run dev` – UI im Browser mit Mock-Daten (`src/mock.ts` + `src/mock-diag.ts`), `?admin=1` simuliert Adminrechte,
    `?fail=renew` lässt jeden Aktions-Schritt scheitern, dessen Befehl „renew“ enthält (Fehlerpfad testen),
    `?net=offline|apipa|nogateway|dnsfail|noicmp` spielt Fehlerfälle für den Health-Check durch,
    `?wifi=none|multi|location` WLAN-Randfälle (kein Adapter / zwei Adapter / Standort aus),
    `?conns=many` 1200 Verbindungen (Grenze 500 Zeilen). WLAN-Mock: Passwort mit „falsch“ = falsches Passwort,
    Netz „Hotspot-Handy“ = Zeitüberschreitung (`src/mock-wifi.ts`).
    `?admin=1&fail=address` IP-Profil anwenden scheitert (sofortige Wiederherstellung),
    `?update=new|private|offline|ratelimit` Update-Check (`src/mock-tools.ts`). Kompaktmodus im Browser =
    Kasten 380×260 (`body.compact-sim`).
  - `cd src-tauri && cargo test` – Rust-Tests (Validierung, Aktions-Abläufe, DNS-Parser, Port-Test, config.json,
    Monitor-Logik, Subnetz-Regeln, MAC/Magic Packet, WLAN-Profil-XML/Escaping, Netze zusammenfassen,
    Traffic-Raten/Zähler-Reset, TCP-Zustände, IP-Profile/netsh-Schritte, Release-URLs).
    Unter Linux braucht das `libwebkit2gtk-4.1-dev` und (Tray) `libayatana-appindicator3-dev`.
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
  wifi.rs      WLAN über wlanapi.dll: Status, Scan, Netzliste (pro SSID zusammengefasst), Profile,
               Verbinden (WlanSetProfile + WlanConnect, Ergebnis per Notification-Callback), Trennen, Vergessen
  wifiprofile.rs  reine Logik: SSID/Passwort prüfen, Profil-XML bauen + escapen, Passwort-Puffer überschreiben
  traffic.rs   Live-Traffic: GetIfTable2-Zähler → Raten (Backend-State, Zähler-Reset → null)
  connections.rs  TCP/UDP-Tabellen (GetExtendedTcp/UdpTable, IPv4+IPv6, PID → Prozessname), Reverse-DNS auf Klick
  icmp.rs      native Pings (IcmpSendEcho, ohne ping.exe/Admin), Resolver mit Zeitlimit, parallel_map
  config.rs    config.json in %APPDATA%\Net-Conf (Monitor-Ziele, WoL-Geräte), atomar, .bak bei Defekt
  monitor.rs   Ping-Monitor im Backend-Thread (Stats, DOWN nach 2 Timeouts, Ausfall-Log, Events)
  lan.rs       LAN-Scanner (SendARP, nur eigenes privates Subnetz ≤ /22), Subnetz-Regeln
  wol.rs       Wake-on-LAN: MAC-Parser, Magic Packet, Broadcast über den gewählten Adapter
  ipprofile.rs IP-Profile: Prüfung, Adapter per MAC finden, Sicherung, netsh-Schritte, Sicherheitsnetz (IpGuard)
  desktop.rs   Tray-Icon + Menü, Kompaktmodus (Fenster umschalten), Autostart (HKCU\Run), Release-Seite öffnen
  winreg.rs    kleine Registry-Helfer (nur Windows): lesen, schreiben, löschen
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
  wifiutil.ts  reine WLAN-Helfer (Kanal-Belegung, Passwort-/SSID-Prüfung als Komfort, Textbalken)
  traffic.ts   reine Traffic-Helfer (Formatierung Mbit/s·MB/s, Filter/Sortierung der Verbindungen)
  mock-wifi.ts Mock für WLAN, Traffic, Verbindungen
  mock-tools.ts Mock für IP-Profile (inkl. Countdown), Kompaktmodus, Autostart, Update-Check
  subnet.ts    Subnetz-Rechner (rein, `>>> 0`-Arithmetik, getestet)
  ipprofile.ts IP-Profile: Formular-Prüfung wie das Backend, Beschreibung, Profil aus Adapter
  themes.ts    Farb-Themes + Schriftarten (FONTS) als Daten, WCAG-Kontrast (getestet), Akzentfarben, Schriftgrössen
  fonts.ts     eingebettete Schriften (woff2) erst bei Bedarf per FontFace laden, fontEpoch() für Graphen
  fuzzy.ts     Fuzzy-Suche der Befehlspalette (rein, getestet)
  registry.ts  Befehls-Registry der Palette (registerCommand, commandById, onCommandsChanged)
  keys.ts      eigene Tastenkürzel: Tastendruck → "Strg+Umschalt+D", Regeln, Konflikte (rein, getestet)
  settingsdata.ts  Einstellungen: Typ, DEFAULTS, sanitizeSettings, Export/Import als Text (rein, getestet)
  update.ts    Update-Check: SemVer, Release-URL-Prüfung, API-Antwort auswerten, fetch (rein bis auf fetch)
  views/       overview.ts (ASCII-Titel, SYSTEM, öffentliche IP, WLAN), actions.ts, tables.ts, settings.ts,
               lan.ts (Scanner + Wake-on-LAN), tests.ts (Reiter) + tests/ping.ts, tracert.ts, dns.ts,
               port.ts, health.ts, monitor.ts, wifi.ts (F7), traffic.ts (Reiter) + traffic/live.ts, connections.ts,
               tools.ts (F9, Reiter) + tools/subnet.ts, profiles.ts, compact.ts (Kompaktansicht)
  ui/          dom.ts (h()-Helfer, Logo, Clipboard), widgets.ts (TUI-Bausteine),
               statusbar.ts (Rückmeldungen statt Toasts), console.ts, modal.ts,
               latencygraph.ts (Block-Graph auf Canvas für Ping/Traffic/WLAN-Signal, Optionen `unit`,
               `nullMark`, `zeroEmpty`; `mini: true` = 1 Zeile für den Monitor), admin.ts,
               palette.ts (Befehlspalette Strg+K), updates.ts (Update-Prüfung + Statusleisten-Hinweis),
               shortcuts.ts (eigene Tastenkürzel ausführen + Aufnahme-Dialog)
  views/settings-keys.ts, settings-backup.ts  Panels TASTENKÜRZEL und SICHERN & ÜBERTRAGEN
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
  **Einzige Ausnahme:** der Update-Check (`api.github.com`, nur `releases/latest` des eigenen Repos) –
  beim Start höchstens 1× pro 24 h, in den Einstellungen abschaltbar (Standard an, so gewünscht).
  Neue externe Hosts müssen in die CSP (`connect-src` in `tauri.conf.json`).
- URLs öffnet nur das Backend (`open_release_page`) und nur `https://github.com/<owner>/<repo>/releases…`
  (`desktop::is_release_url`, gespiegelt in `update.isReleaseUrl`). Owner/Repo: `REPO_OWNER/REPO_NAME` in
  `desktop.rs` und `update.ts` (aus dem Git-Remote `fralineel-kiesel/net-conf`).
- WLAN ab Windows 11 24H2: SSID/BSSID nur mit Standortzugriff für Desktop-Apps →
  verständlicher Hinweis statt Fehlercode (`wifi::LOCATION_HINT`).
- Konservativ coden: lieber einfach und sicher kompilierend als clever.
- Viele kurze Pings (Health, Monitor, Scan, WoL-Check) **nur über `icmp.rs`** (IcmpSendEcho), nie ping.exe.
  Der Ping-Test (Tests → Ping) bleibt bei ping.exe, damit man dort die echte Windows-Ausgabe sieht.
- Parallelität immer begrenzen (`icmp::parallel_map`): Scan 64, Monitor ≤ 20 (= max. Ziele).
- Seiten mit Timern (WLAN 2 s, Traffic 1 s, Verbindungen-Auto 2 s) messen **nur, solange sie sichtbar sind**:
  `activate()`/`deactivate()` über `lifecycle` in `main.ts`. Timer als `setTimeout`-Kette mit Generationszähler
  (keine überlappenden Aufrufe, nach dem Verlassen kein Takt mehr).
- Dauerhafte Daten, die das Backend kennen muss (Monitor-Ziele, WoL-Geräte, IP-Profile, `closeToTray`), in `config.json` über
  `config.rs` – nie direkt schreiben. Beim Speichern streng prüfen, beim Laden Ungültiges verwerfen.
  Reine Anzeige-Einstellungen (Theme, Akzent, Schriftgrösse, Update-Check an/aus) bleiben im localStorage (`settings.ts`).

### Sicherheitsregeln IP-Profile (Werkzeuge → IP-Profile)
- Das Frontend schickt beim Anwenden **nur den Profilnamen** (`ip_profile_preview`/`ip_profile_apply`). Das Backend
  liest das Profil aus config.json, prüft es erneut (`ipprofile::check_profile`) und sucht den Adapter über die
  gespeicherte **MAC** in der aktuellen Adapterliste (gleiche MAC mehrfach → Name entscheidet; leere MAC → exakter Name).
- Prüfung: IPs per `Ipv4Addr`-Parsing (keine führenden Nullen), Maske zusammenhängend (`255.255.255.0`, `/24`, `24`,
  gespeichert immer als Punktnotation), Host-IP nicht Netz-/Broadcast-/Multicast-/Loopback-/0.x/240+-Adresse
  (/31 und /32 nach RFC 3021 ohne Netz/Broadcast), Gateway im Subnetz und ≠ eigene IP, DNS 2 nur mit DNS 1.
- netsh in Positionsform, Adaptername als eigenes Argument (wie `adapterRestart`):
  `netsh interface ipv4 set address "<Name>" static <IP> <Maske> <GW>|gateway=none` bzw. `… dhcp`,
  `set dnsservers "<Name>" static <DNS1> primary validate=no` + `add dnsservers "<Name>" <DNS2> index=2 validate=no`
  bzw. `… dhcp` / `static none`. Unveränderte Teile werden übersprungen (`set address … dhcp` scheitert, wenn DHCP schon aktiv ist).
- **Sicherheitsnetz:** Vor dem Anwenden wird die Konfiguration gesichert (erste IPv4, Maske, erstes Gateway, max. 2 DNS;
  ob DNS fest eingetragen ist, steht in `HKLM\…\Tcpip\Parameters\Interfaces\{GUID}\NameServer`). Nach dem Anwenden
  Event `ip-profile` `pending` → 30 s Countdown, nur `ip_profile_keep` behält. Ohne Bestätigung, bei einem gescheiterten
  Schritt oder beim Beenden der App (`IpGuard::revert_and_wait` im Exit-Handler) stellt **das Backend selbst** wieder her –
  dafür wird der IST-Zustand neu gelesen, die Rücknahme-Schritte sind `always` (laufen auch nach einem Fehler weiter).
- Immer nur eine IP-Änderung gleichzeitig (`IpGuard`). Anwenden braucht Admin (Backend prüft `is_admin`), ist [!] mit
  `confirmDialog({ danger: true })` und zeigt vorher alt → neu + netsh-Befehle (Vorschau vom Backend).

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

### Sicherheitsregeln WLAN (F7)
- **Kein `netsh wlan`** – alles über wlanapi (`wifi.rs`). Das Frontend schickt nur die Interface-GUID
  (wird mit `WlanEnumInterfaces` **verglichen**, nie selbst geparst), Profilnamen (müssen exakt in
  `WlanGetProfileList` stehen) und für neue Netze SSID + Passwort + Sicherheit.
- **Passwort nie loggen/speichern:** nicht in Konsole, Statusleiste, Fehlermeldungen, localStorage oder
  config.json. `WifiConnectRequest` hat **kein** `Debug`-derive. Nach Gebrauch werden Passwort-String und
  XML-Puffer überschrieben (`wifiprofile::wipe_string/wipe_wide`). Im Frontend wird das Feld beim Absenden
  geleert und die Referenz verworfen; Formular schliessen/Seite verlassen leert es ebenfalls.
  Das Passwortfeld ist absichtlich `type="text"` (sichtbar beim Tippen, so gewünscht), `spellcheck`/`autocomplete` aus.
- **XML-Escaping:** SSID und Passwort gehen nur escaped (`& < > " '`) ins Profil-XML (`wifiprofile::profile_xml`,
  mit Tests); die SSID steht zusätzlich als Hex drin. Validierung: SSID 1–32 **Byte**, keine Steuerzeichen;
  WPA2: 8–63 druckbare ASCII-Zeichen oder 64 Hex, WPA3 (SAE): 8–63, offen: kein Passwort.
- Profile: WPA2PSK/AES, WPA3SAE/AES oder open/none, `connectionMode auto`, `nonBroadcast` bei versteckten Netzen,
  `WlanSetProfile` mit Flags 0 (normales Profil für alle Benutzer – wie Windows selbst).
- Bei sichtbaren Netzen bestimmt das **Backend** die Sicherheit (aus der Netzliste), die Wahl im Frontend gilt nur
  für versteckte Netze. 802.1X/Enterprise, WEP, WPA1, OWE: nicht unterstützt → „[802.1X] nicht unterstützt, bitte
  über Windows verbinden“. Gruppenrichtlinien-Profile (GPO) werden weder überschrieben noch gelöscht.
- Scheitert die Verbindung, bleibt **kein** Profil mit falschem Passwort zurück: neues Profil wird gelöscht,
  ein überschriebenes aus der Sicherung (`WlanGetProfile`, Schlüssel verschlüsselt) wiederhergestellt.
- Ergebnis über `WlanRegisterNotification` (eigenes Handle; erst nach `WlanCloseHandle` den Kontext freigeben),
  max. 30 s. `strProfileXml` aus der Notification nie lesen. Gründe → deutsche Texte (`wifi::explain_reason`):
  falsches Passwort, Zeitüberschreitung, nicht erreichbar; sonst Windows-Text (`WlanReasonCodeToString`).
- Trennen und Vergessen sind [!]-Aktionen mit `confirmDialog({ danger: true })`. Es läuft immer nur ein
  Verbindungsversuch (`ConnectGuard`).

## Design-Regeln: TUI-Look (wie htop, btop, lazygit)
Die App soll wie eine Terminal-Oberfläche wirken, bleibt aber per Maus bedienbar.
**Kein** „KI-Webseiten-Look“ (runde Karten, Glow, Pillen, Punkte, Toggle-Schalter).
Die Regeln gelten in **jedem** Theme – Themes ändern nur Farben.

Verboten:
- `border-radius` (überall 0), `box-shadow`, `text-shadow`, Glow, `filter`, Verläufe.
- Transitions und Animationen – ein Terminal reagiert sofort.
  **Einzige Ausnahme:** der blinkende Block-Cursor `.cursor` (hart an/aus, `steps(1)`).
- Pillen-Badges, Toggle-Schalter, Toasts, Web-App-Icons, Status-Punkte.
- Fettdruck, mehrere Schriftgrössen, Letter-Spacing.
  (Die eine Schriftgrösse ist einstellbar: 10–20 px, Standard 13, Strg +/−/0 → `--fs`.)

Farben – **nur** über CSS-Variablen (`--bg --bar --line --text --dim --bright --accent --ok --err --warn --backdrop`):
- Werte stehen in `src/themes.ts` (12 Themes: Cyan = Standard, Amber, Phosphor, Papier, Kontrast, DOS-Blau,
  Mitternacht, Synthwave, Sepia, Retro-CRT, Arktis, Graphit); `applySettings()` setzt sie per JS.
  `:root` in `styles.css` muss exakt Theme „Cyan“ entsprechen (prüft `scripts/theme.test.ts`).
- Neues Theme: Eintrag in `THEMES` – der Test rechnet nach: Text, Werte, Akzent, ok/err/warn ≥ 4.5:1 auf `--bg`,
  ok/err ≥ 4.5:1 auf `--bar`, Hover (`--bg` auf `--accent`) ≥ 4.5:1, gedimmt ≥ 3:1.
- Keine hartkodierten Farben in CSS/TS (Ausnahme: Theme-Vorschau in den Einstellungen und das Logo).
- Hintergrund fast schwarz `--bg #0b0e12`, Schrift hellgrau `--text`.
- Labels gedimmt `--dim`, Werte/Titel hell `--bright`.
- **Eine** Akzentfarbe, Standard Cyan `--accent #22d3ee` – NUR für Interaktives (Hover, Fokus, aktiver Menüpunkt, Auswahl).
  Im Theme Cyan wählbar (Cyan, Bernstein, Magenta, Blau, Weiss) – **nie Grün/Rot** (Ausnahme: Theme Phosphor ist
  komplett grün, so gewünscht). Andere Themes bringen ihren Akzent mit. Das Logo bleibt immer Cyan.
- Grün `--ok` / Rot `--err` / Warnung `--warn` NUR als **Textfarbe für Status-Wörter** (`.tag-ok`, `.tag-err`, `.tag-warn`),
  nie als Punkt, Linie, Rahmen oder Hintergrund. `--warn` ist im Standard-Theme = `--bright`.
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
- `table()` – Text-Tabelle mit ausgerichteten Spalten (Kopfzeile gedimmt, GROSS). Mit `onSort`/`sorted`
  pro Spalte wird der Kopf zum Sortier-Button `PROZESS ▲`.
- `hashBar()` – Textbalken `[#####-----]` (WLAN-Signal, Kanal-Belegung).
- `copyable()` – Wert, der sich per Klick kopiert; `bar()` – Balken `██████░░░░`.
- Rückmeldungen (z. B. `kopiert: <Wert>`, Fehler) über `status()` in die Statusleiste – keine Toasts.

Layout:
- Kopfzeile: eine Textzeile `[Logo] net-conf @ HOST … [ADMIN]|[USER] [ Neu laden ] (F5)`.
- Seitenleiste: Textmenü mit `>`-Marker und Tastenkürzeln (siehe Seitenübersicht unten).
- Hauptbereich, darunter Konsole (gleiches Panel-Design), ganz unten Statusleiste (wie vim/tmux).
- Schrift: **nur Monospace**, **eine** Grösse überall (`--fs`, Standard 13px), Familie über `--font`.
  Jedes Theme bringt eine Schriftart mit (`Theme.font`), Einstellung „Schriftart“ kann sie überschreiben (`settings.font`,
  `"theme"` = vom Theme). Schriften in `themes.ts → FONTS`: Windows-vorinstalliert (Cascadia Mono, Consolas,
  Lucida Console, Courier New) oder **eingebettet** (woff2 in der App, `src/fonts.ts`, lädt erst bei Bedarf).
  **Nie Web-Fonts aus dem Internet** (offline!) – neue eingebettete Schrift: nur OFL/freie Lizenz, nur latin + 400,
  Familienname mit Präfix `NC ` (keine Verwechslung mit installierten Schriften), immer mit Fallback-Stapel.
  `scale` gleicht optisch kleine Schriften aus (VT323 ×1.45): effektive Grösse = `round(fontSize × scale)`.
- Einheiten: Breiten in `ch`, Höhen über `--lh` (JS: `lineHeightFor(fs)`, 13 → 18 px), Abstände in rem als
  `calc(12rem / 13)` (= 12px bei 13px Schrift). Kein neues `px` ausser 1px-Linien und Scrollbalken.
  Canvas-Graphen lesen die Schriftgrösse aus `getComputedStyle` und messen die Zeichenbreite neu, wenn sich
  Schrift/Grösse ändert oder eine eingebettete Schrift fertig geladen ist (`fontEpoch()`).
  Browser-Zoom (Strg +/−, Strg+Mausrad) wird abgefangen.
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
| F7 | WLAN | Verbindung (live, Signal-Graph), Netze in der Umgebung, Kanal-Belegung, Profile, Verbinden |
| F8 | Traffic | Reiter Live · Verbindungen (nochmal F8 = nächster Reiter) |
| F9 | Werkzeuge | Reiter Subnetz · IP-Profile (nochmal F9 = nächster Reiter) |
| F10 | Einstellungen | Suchfeld; Darstellung (Theme, Schriftart, Akzent, Grösse, Cursor), Allgemein (Ping-Ziel/-Anzahl, Konsole mit Uhrzeit, Uhr, Monitor-Autostart, Start-Ansicht), Tastenkürzel, Fenster (Tray, Autostart), Updates, Sichern & Übertragen, Info |
| Strg+K | Befehlspalette | Suche über Seiten, Aktionen, Tests, Werkzeuge, Einstellungen |

Neue Seite: `ViewId` in `settings.ts`, `NAV` + `views` (+ ggf. `lifecycle`) in `main.ts`, `START_VIEWS` in `views/settings.ts`.
Seiten aus NAV landen automatisch in der Befehlspalette; Reiter und Funktionen meldet die Seite selbst an (siehe unten).

## Befehlspalette (Strg+K) – Registry
- `src/registry.ts`: `registerCommand({ id, title, category, hint?, keywords?, param?, visible?, run })`.
  Kategorien: `SEITE` `AKTION` `TEST` `TOOL` `EINSTELLUNG` (als Tag `[SEITE]` angezeigt). Gleiche `id` ersetzt.
- **Jede Seite meldet ihre Befehle beim Erzeugen selbst an** (z. B. `views/actions.ts` alle Aktionen, `tests.ts`
  die Reiter, `lan.ts` „wol“, `tools.ts` „subnet“/„profil“, `views/settings.ts` Themes/Schriftarten/Schriftgrösse,
  `main.ts` Seiten).
- Parameter-Befehle: `param: { keyword: "ping", placeholder: "<ziel>", validate, suggest? }` → Eingabe „ping 1.1.1.1“.
  `validate` = **dieselbe** Prüfung wie auf der Seite (z. B. `validateTarget`). Vorhanden: `ping`, `traceroute`,
  `nslookup`, `wol <Gerätename>`, `subnet <ip/cidr>`, `profil <Name>`.
- `run` muss dieselbe Funktion wie der Button der Seite aufrufen (Aktionen → `onButton(def)`, Profile → `apply()`),
  also mit Admin-Hinweis und Bestätigungsdialog. Die Palette schliesst sich **vor** `run` – nie an einem Dialog vorbei.
- Suche: `fuzzy.ts` (Titel: Teilstring oder Teilfolge, Stichwörter nur Teilstring; Akzente egal). Strg+K ist gesperrt,
  solange ein Dialog offen ist; F-Tasten sind gesperrt, solange die Palette offen ist.

## Einstellungen und eigene Tastenkürzel
- Neue Einstellung: Feld in `Settings` + `DEFAULTS` + Prüfung in `sanitizeSettings` (`settingsdata.ts`) + Test in
  `scripts/settings.test.ts`; UI in `views/settings.ts`. Gespeichert im localStorage, beim Laden/Import immer geprüft
  (Unbekanntes fällt weg, Ungültiges wird Standard). Arrays (z. B. `keybindings`) nie verändern, immer ersetzen.
- Export/Import: JSON-Text mit `kind: "net-conf-settings"`, `format: 1` über die Zwischenablage. Enthält NUR die
  localStorage-Einstellungen – config.json-Daten (IP-Profile, WoL, Monitor-Ziele, Tray) nicht.
- **Tastenkürzel** binden eine Kombination an eine Registry-Befehls-ID (nur Befehle ohne Parameter). Ausgeführt wird
  `cmd.run()` – derselbe Weg wie die Palette, also mit Admin-Hinweis und Bestätigung. Nicht aktiv, solange ein Dialog,
  die Palette oder eine Aufnahme offen ist. Regeln (`keys.checkCombo`): mit Strg oder Alt (ohne nur F11–F24),
  kein Strg+Alt (= AltGr), keine festen Kürzel (`RESERVED`: F1–F10, Strg+K, Strg +/−/0, Strg+A/C/V/X/Z/Y, Alt+F4 …),
  keine Doppelbelegung (Konflikt → Nachfrage „Ersetzen“), max. 50, ein Kürzel pro Befehl. Namen deutsch
  („Strg+Umschalt+D“, „Pfeil↑“, „Plus“), Buchstaben nach `e.key` (deutsches Layout), Ziffern nach `e.code`.
- Befehle, die man gern auf Tasten legt, als Registry-Befehl anmelden (z. B. `console.clear`, `test.monitor.toggle`,
  `test.ping.default`, `app.compact`). main.ts meldet einige Befehle erst nach den Seiten an → Listen, die Befehle
  anzeigen, über `onCommandsChanged` neu aufbauen.

## Tray, Kompaktmodus, Autostart (desktop.rs)
- Tray-Icon (App-Icon) mit Menü „Öffnen“, „Kompaktmodus“, „Beenden“; Linksklick zeigt das Fenster.
- Fenster startet unsichtbar (`"visible": false`) und wird im `setup` gezeigt – ausser mit `--tray` (Autostart),
  und nur, wenn das Tray-Icon angelegt werden konnte (sonst wäre die App unerreichbar).
- „Beim Schliessen in den Tray minimieren“ (`closeToTray` in config.json, Standard aus): `CloseRequested` → verstecken.
- Kompaktmodus: **ein** Fenster wird umgeschaltet (`set_compact`): 380×260 logisch, immer im Vordergrund, Mindestgrösse
  300×200; vorher Position/Grösse/Maximiert merken und beim Zurückschalten wiederherstellen. Event `compact-changed`
  → `body.compact` blendet Seitenleiste/Konsole aus, `views/compact.ts` pingt (ICMP) Gateway + 1.1.1.1 alle 2 s,
  nur solange aktiv. Die verdeckte Seite wird per `lifecycle` pausiert. „Seite zeigen“ beendet den Kompaktmodus.
- Autostart: `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, Wert „Net-Conf“ = `"<exe>" --tray` (Pfad baut nur
  das Backend). Kein Admin nötig; Hinweis im UI: Autostart läuft immer **ohne** Adminrechte.

## Update-Hinweis
- `update.ts`: `fetchLatestRelease()` → `GET https://api.github.com/repos/<owner>/<repo>/releases/latest` per fetch
  (wie ipify), Auswertung `interpretRelease()`, Vergleich `isNewer()` (SemVer inkl. Vorabversionen), getestet.
- `ui/updates.ts`: beim Start (Einstellung „Beim Start nach Updates suchen“, Standard an) höchstens 1× pro 24 h,
  Fehler still; „Jetzt prüfen“ zeigt verständliche Meldungen (404 → „Repository ist privat oder nicht erreichbar“).
  Neuere Version → Statusleiste `[UPDATE v0.x.y]` (klickbar, bleibt gemerkt) → `open_release_page`. Kein Download.
- Release: Tag `v*` → Workflow prüft, dass der Tag zu allen drei Versionsnummern passt, baut und hängt die .exe an;
  Tags mit `-` (z. B. `v0.7.0-beta.1`) werden Pre-release. Klickpfad steht im README („Release veröffentlichen“).

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

## WLAN, Traffic, Verbindungen (Phase 4b)
- **WLAN (F7):** VERBINDUNG alle 2 s (`get_wifi`), Signal-Graph über 1 min (30 Werte, feste Skala 0–100 %,
  getrennt = ×), [ Trennen ] [!]. NETZE: [ Scannen ] = `WlanScan`, nach 3,5 s Liste neu laden; Spalten SSID
  (versteckt = `<versteckt>`), Signal `[#####-----] %`, Kanal, Band, Sicherheit, AP, [VERBUNDEN]/[GESPEICHERT];
  gleiche SSID = eine Zeile (stärkster AP, Anzahl AP), sortiert nach Signal. KANAL-BELEGUNG: 2,4 GHz immer
  Kanal 1–13, 5/6 GHz nur belegte, eigener Kanal [EIGENER]. Mehrere WLAN-Adapter → Auswahl.
  Leere Liste / keine SSIDs → Hinweis „Windows blendet WLAN-Namen aus …“ (`NAMES_HIDDEN_HINT`).
- **Traffic → Live (F8):** `traffic_poll` 1×/s nur bei offener Seite (`traffic_reset` beim Öffnen). Backend hält
  den letzten Zählerstand (Tauri-State `Traffic`); negative Differenz (Zähler-Reset) oder Pause > 5 s → `null`
  (Lücke im Graphen, keine Spitze). Nur Adapter aus der Übersicht (GUID-Abgleich), Filter-Interfaces fallen weg,
  virtuell = nicht `HardwareInterface` (ausblendbar). Anzeige Mbit/s **und** MB/s (dezimal), Spitze, Summe seit
  Messbeginn (Öffnen, Adapterwechsel, [ Zurücksetzen ]), Link-Geschwindigkeit.
- **Traffic → Verbindungen:** TCP/UDP, IPv4/IPv6 mit PID; PID 0/4 = „System“, ohne Zugriff „(kein Zugriff)“.
  Textfilter über alle Spalten, [Alle] [LISTEN] (inkl. UDP) [ESTABLISHED], Sortierung per Spaltenkopf,
  Auto alle 2 s (Standard aus, nur bei sichtbarem Reiter). Klick auf Adresse kopiert die IP, [ Auflösen ] =
  PTR für diese eine Adresse (`reverse_dns`). Max. 500 Zeilen, dann Hinweis „Filter verwenden“.
  Bewusst **kein** „Prozess beenden“. (Die Seite Tabellen F4 hat nur ARP/Routen – kein Duplikat.)

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

## Graph-Skalen (Ping und Traffic)
- Beide nutzen `StepScale` aus `pingscale.ts` (`LatencyScale`, `TrafficScale`), Tests: `npm test`.
- Balken proportional ab **0** (fester Nullpunkt, nie ab dem Minimum). Jeder Wert > 0 mind. 1 Stufe hoch.
- **Ping:** Obergrenze = nächste Stufe aus `[10, 20, 50, 100, 200, 500, 1000]` ms über dem Maximum der
  **sichtbaren** Werte, mindestens 10 ms (über 1000: volle Sekunden).
- **Traffic:** Stufen `[1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]` Mbit/s, mindestens 1 (über 1000: volle 1000er).
  Wert 0 = kein Balken (`zeroEmpty`), fehlende Messung = Lücke (`nullMark: "none"`). Je ein Graph für
  Download und Upload, 3 Zeilen hoch, Skala-Label rechts („Skala 0-100 Mbit/s“).
- **WLAN-Signal:** feste Skala 0–100 %, keine Hysterese.
- Hysterese (Ping + Traffic): wächst **sofort**; schrumpft erst, wenn das Maximum über **10 Messungen** in Folge
  ≤ 80 % einer kleineren Stufe lag.
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
- **Phase 4b (fertig, v0.5.0):** WLAN-Seite (F7) mit Scan, Kanal-Belegung, Profilen, Verbinden/Trennen/Vergessen;
  Traffic-Seite (F8) mit Live-Raten und Verbindungen/Prozessen.
- **Phase 4c (fertig, v0.6.0):** Werkzeuge (F9) mit Subnetz-Rechner und IP-Profilen (Sicherheitsnetz),
  Befehlspalette (Strg+K) mit Registry, Themes + Schriftgrösse, Tray + Kompaktmodus + Autostart, Update-Hinweis.
- **Ideen für später (NICHT bauen ohne Auftrag):**
  - IP-Profile: mehrere IPv4-Adressen/Gateways und IPv6 sichern/setzen
  - Traffic: Verlauf pro Prozess (bräuchte ETW – deutlich aufwendiger)
  - WLAN: OWE/WPA3-Übergangsmodus gezielt unterstützen, 802.1X bewusst nicht
  - Hersteller zur MAC (OUI) im LAN-Scanner: nur mit kompakter eingebetteter Tabelle (< 300 KB);
    die volle IEEE-Liste ist deutlich grösser – daher in 4a weggelassen
  - IPv6 im ICMP-Modul (Icmp6SendEcho2) für Monitor/Health
  - Speed-/Latenz-Langzeitmessung mit Export (CSV)
  - Ergebnisse als Text für Tickets exportieren
