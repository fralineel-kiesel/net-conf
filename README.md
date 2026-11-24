# Net-Conf

Netzwerk-Helfer für Windows 11 im Terminal-Look (TUI wie htop/btop – aber mit Maus bedienbar).

Net-Conf zeigt die Infos von `ipconfig /all` übersichtlich als Karten an
und bietet Buttons für häufige Netzwerk-Befehle:

- **Übersicht** – eine Karte pro Adapter (IPv4/IPv6, Gateway, DNS, DHCP, Lease, MAC …). Klick auf einen Wert kopiert ihn.
- **Aktionen** – `ipconfig /release`, `/renew`, `/flushdns`, `/registerdns` per Klick.
- **Tests** – Ping mit Live-Statistik und Latenz-Verlauf.
- **Konsole** – die Rohausgabe aller Befehle live mitlesen.

Tastenkürzel: **F1** Übersicht · **F2** Aktionen · **F3** Tests · **F5** Neu laden.

Gebaut mit [Tauri v2](https://tauri.app) (Rust) und reinem TypeScript – klein, schnell, ohne Installation lauffähig.

## Herunterladen

**Fertige Version (Release):** Auf GitHub unter *Releases* die neueste Version öffnen und eine Datei laden:

- `Net-Conf_…_x64-setup.exe` – Installer (installiert nur für den aktuellen Benutzer, keine Adminrechte nötig)
- `net-conf.exe` – portable Version, einfach starten

**Neuester Build (jeder Commit):** Unter *Actions* → Workflow *Build* → letzten erfolgreichen Lauf öffnen → unten bei *Artifacts* `Net-Conf-portable` oder `Net-Conf-Installer` herunterladen (ZIP, GitHub-Login nötig).

> Windows SmartScreen warnt eventuell („Unbekannter Herausgeber“), weil die App nicht signiert ist: *Weitere Informationen → Trotzdem ausführen*.

Für `IP freigeben/erneuern` und `DNS neu registrieren` braucht die App Administratorrechte. Net-Conf bietet dafür einen Button „Als Administrator neu starten“ an.

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

**Nur die Oberfläche ansehen (jedes Betriebssystem):** `npm run dev` und <http://localhost:1420> im Browser öffnen. Ohne Tauri läuft die App automatisch mit Testdaten („Mock-Modus“). Mit `?admin=1` in der URL tut sie so, als hätte sie Adminrechte.

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
