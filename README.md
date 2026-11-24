# Net-Conf

Netzwerk-Helfer für Windows 11 im Terminal-Look (TUI wie htop/btop – aber mit Maus bedienbar).

Net-Conf zeigt die Infos von `ipconfig /all` übersichtlich als Karten an
und bietet Buttons für häufige Netzwerk-Befehle:

- **Übersicht** – Schnellüberblick (Hostname, primärer Adapter mit IP, Gateway, DNS) und ein Panel pro Adapter (IPv4/IPv6, Gateway, DNS, DHCP, Lease, MAC …), beim WLAN-Adapter zusätzlich SSID, Signal, Kanal/Band und Sicherheit. Öffentliche IP auf Knopfdruck. Klick auf einen Wert kopiert ihn.
- **Aktionen** – in Gruppen: IP/DHCP (freigeben, erneuern, **Release + Renew**, Voller Refresh), DNS (Cache leeren/anzeigen, neu registrieren), ARP- und NetBIOS-Cache, Adapter neu starten, Winsock/TCP-IP zurücksetzen. Abläufe zeigen ihre Schritte und lassen sich abbrechen.
- **Tests** – Ping (2–32 Pakete oder unbegrenzt) mit Live-Statistik und Latenz-Graph, Traceroute mit Hop-Tabelle, DNS-Abfrage (wie nslookup) und Port-Test.
  - **Health** – prüft auf Knopfdruck die ganze Kette (Adapter → IP → Gateway → DNS-Server → DNS-Auflösung → Internet) und sagt auf Deutsch, wo sie bricht. Ergebnis lässt sich als Text kopieren.
  - **Monitor** – bis zu 20 Ziele dauerhaft anpingen (1–10 s), mit Status UP/DOWN, Verlust, Mini-Verlauf und Ausfall-Log. Läuft im Hintergrund weiter, auch wenn man die Seite wechselt.
- **Tabellen** – ARP-Tabelle und Routing-Tabelle mit Filter.
- **LAN** – Scanner für das eigene Subnetz (IP, Hostname, MAC, Latenz) und **Wake-on-LAN** mit Geräteliste. Gescannt werden nur eigene private Netze bis /22.
- **WLAN** – aktuelle Verbindung live (Signal, Kanal/Band, Funkstandard, Datenraten) mit Signal-Graph der letzten Minute, Netze in der Umgebung (scannen, nach Signal sortiert), Kanal-Belegung, gespeicherte Profile (verbinden, vergessen) und **Verbinden mit neuen Netzen** (WPA2/WPA3/offen, auch versteckte).
- **Traffic** – Live-Datenrate eines Adapters (Mbit/s und MB/s, Spitze, Summe, zwei Graphen) und **Verbindungen** mit Prozess (wie `netstat -ano`) mit Filter, Sortierung und Reverse-DNS auf Klick.
- **Einstellungen** – Akzentfarbe, Standard-Ping-Ziel, Konsolen-Höhe, Start-Ansicht.
- **Konsole** – die Rohausgabe aller Befehle live mitlesen.

Tastenkürzel: **F1** Übersicht · **F2** Aktionen · **F3** Tests (nochmal F3 = nächster Reiter) · **F4** Tabellen · **F6** LAN (nochmal F6 = nächster Reiter) · **F7** WLAN · **F8** Traffic (nochmal F8 = nächster Reiter) · **F10** Einstellungen · **F5** Neu laden.

### Hinweise

- **WLAN-Details unter Windows 11:** Seit Version 24H2 gibt Windows SSID und Access-Point-Infos nur frei, wenn Desktop-Apps den Standort verwenden dürfen: *Einstellungen → Datenschutz und Sicherheit → Standort → „Desktop-Apps den Zugriff auf Ihren Standort erlauben“*. Ohne das zeigt Net-Conf einen Hinweis statt der Daten.
- **Öffentliche IP:** wird nur auf Klick über den Dienst [ipify.org](https://www.ipify.org) abgefragt, nie automatisch.
- **DNS-Abfrage:** fragt den gewählten DNS-Server direkt (wie `nslookup`), nicht den Windows-DNS-Cache.
- **Pings ohne Adminrechte:** Health-Check, Monitor, LAN-Scan und WoL-Check pingen direkt über die Windows-API (kein `ping.exe`, nur IPv4).
- **LAN-Scanner:** Nur im eigenen bzw. erlaubten Netz verwenden. Es gibt bewusst kein Feld für beliebige IP-Bereiche.
- **Wake-on-LAN:** Das Zielgerät muss WoL aktiviert haben (BIOS/UEFI und Netzwerkkarte). „Gesendet“ heisst nicht „aufgewacht“.
- **WLAN verbinden:** Net-Conf legt ein normales Windows-WLAN-Profil an (wie beim Verbinden über Windows). Das Passwort ist beim Tippen sichtbar, geht nur an Windows und wird von Net-Conf nirgends gespeichert oder protokolliert. Klappt die Verbindung nicht (z. B. falsches Passwort), bleibt kein Profil mit dem falschen Passwort zurück. Firmen-WLANs mit 802.1X/Anmeldung werden nicht unterstützt – dafür bitte über Windows verbinden.
- **WLAN-Namen fehlen?** Ohne Standortzugriff blendet Windows die SSIDs aus (siehe oben).
- **Traffic und WLAN messen nur, solange die Seite offen ist** – im Hintergrund läuft nichts.
- **Verbindungen:** Ohne Adminrechte zeigt Windows bei manchen Prozessen nur „(kein Zugriff)“. Prozesse beenden kann Net-Conf bewusst nicht.
- **Gespeicherte Daten:** Monitor-Ziele und WoL-Geräte liegen in `%APPDATA%\Net-Conf\config.json`. Ist die Datei beschädigt, legt Net-Conf eine Sicherung `config.json.bak` an und startet mit Standardwerten.

Gebaut mit [Tauri v2](https://tauri.app) (Rust) und reinem TypeScript – klein, schnell, ohne Installation lauffähig.

## Herunterladen

**Fertige Version (Release):** Auf GitHub unter *Releases* die neueste Version öffnen und eine Datei laden:

- `Net-Conf_…_x64-setup.exe` – Installer (installiert nur für den aktuellen Benutzer, keine Adminrechte nötig)
- `net-conf.exe` – portable Version, einfach starten

**Neuester Build (jeder Commit):** Unter *Actions* → Workflow *Build* → letzten erfolgreichen Lauf öffnen → unten bei *Artifacts* `Net-Conf-portable` oder `Net-Conf-Installer` herunterladen (ZIP, GitHub-Login nötig).

> Windows SmartScreen warnt eventuell („Unbekannter Herausgeber“), weil die App nicht signiert ist: *Weitere Informationen → Trotzdem ausführen*.

Viele Aktionen (z. B. `IP freigeben/erneuern`, `DNS neu registrieren`, Caches leeren, Adapter neu starten) brauchen Administratorrechte – sie sind mit `[ADMIN]` markiert. Net-Conf bietet dafür einen Button „Als Administrator neu starten“ an.

## Selbst bauen

Voraussetzungen (Windows): [Node.js LTS](https://nodejs.org), [Rust](https://rustup.rs) und die [Tauri-Voraussetzungen](https://tauri.app/start/prerequisites/) (Visual Studio Build Tools mit „Desktopentwicklung mit C++“; WebView2 ist in Windows 11 schon enthalten).

```bash
npm ci
```

```bash
npm run tauri dev
```

```bash
npm run tauri build
```

Ergebnis:

- `src-tauri/target/release/net-conf.exe` (portabel)
- `src-tauri/target/release/bundle/nsis/*-setup.exe` (Installer)

**Nur die Oberfläche ansehen (jedes Betriebssystem):** `npm run dev` und <http://localhost:1420> im Browser öffnen. Ohne Tauri läuft die App automatisch mit Testdaten („Mock-Modus“). Mit `?admin=1` in der URL tut sie so, als hätte sie Adminrechte; mit `?fail=renew` scheitert jeder Aktions-Schritt mit „renew“ (zum Testen der Fehlermeldungen); mit `?net=dnsfail` (oder `offline`, `apipa`, `nogateway`, `noicmp`) zeigt der Health-Check typische Fehlerfälle; `?wifi=none`, `?wifi=multi` und `?wifi=location` spielen WLAN-Randfälle durch, `?conns=many` liefert über 1000 Verbindungen.

**ASCII-Titel neu erzeugen** (nur nötig, wenn er sich ändern soll): `pip install pyfiglet`, dann `python scripts/make-title.py`.

## Logo / Icons

Die Quelle ist `assets/logo.svg`. Nach Änderungen die Icons neu erzeugen:

```bash
npx tauri icon assets/logo.svg -o src-tauri/icons
```

(Die erzeugten Ordner `android/` und `ios/` werden nicht gebraucht.)

## Release erstellen

Version in `package.json`, `src-tauri/Cargo.toml` und `src-tauri/tauri.conf.json` erhöhen, committen und einen Tag pushen:

```bash
git tag v0.1.0
```

```bash
git push origin v0.1.0
```

GitHub Actions baut dann automatisch und legt ein Release mit beiden `.exe`-Dateien an.
