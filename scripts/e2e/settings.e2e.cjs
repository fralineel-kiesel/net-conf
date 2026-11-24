// Ende-zu-Ende-Test der Einstellungen im Browser-Mock (Playwright): npm run e2e
//
// Voraussetzungen:
//   1. Dev-Server läuft:  npm run dev   (Adresse ändern mit NETCONF_URL=http://…)
//   2. Playwright ist installiert (in der Claude-Cloud vorinstalliert; lokal: npm i -D playwright
//      und npx playwright install chromium). Bewusst KEINE feste Abhängigkeit im Projekt.
//
// Geprüft wird: Suche, Tastenkürzel (anlegen, ausführen, verbotene Kombinationen, Konflikt,
// Gefahr-Aktionen nur mit Dialog), Konsole mit Uhrzeit, Uhr, Cursor, Ping-Anzahl,
// Export/Import, Monitor-Autostart, Zurücksetzen.
const { chromium } = require('playwright');
const BASE = process.env.NETCONF_URL || 'http://localhost:1420/';
let fails = 0;
const check = (cond, msg) => { console.log(cond ? 'ok  ' : 'FAIL', msg); if (!cond) fails++; };

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1100, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push(String(e)));
  const open = async (q = '') => { await p.goto(BASE + q); await p.waitForTimeout(700); };
  const sb = () => p.textContent('.sb-msg');
  const consoleText = () => p.textContent('.console-body');
  const goSettings = () => p.click('.menu-item:has-text("Einstellungen")');

  await open(); await p.evaluate(() => localStorage.clear()); await open();

  // --- 1. Suche ---------------------------------------------------------------------
  await goSettings();
  await p.fill('.settings-search input', 'uhr');
  const visible = await p.$$eval('[data-view=settings] .kv-row', rows => rows.filter(r => r.offsetParent).map(r => r.querySelector('.kv-label').textContent.trim()));
  check(visible.includes('Statusleiste') && visible.length <= 4, `Suche "uhr" zeigt nur passende Zeilen: ${visible.join(', ')}`);
  await p.fill('.settings-search input', 'xyzabc');
  check((await p.textContent('.settings-search')).includes('keine Treffer'), 'Suche ohne Treffer meldet "keine Treffer"');
  await p.fill('.settings-search input', '');

  // --- 2. Tastenkürzel anlegen und benutzen -----------------------------------------------
  await p.click('.keys-panel .panel-right .tbtn');
  await p.selectOption('.keys-editor select', 'action.flushDns');
  await p.click('.keys-editor .tbtn:has-text("Taste aufnehmen")');
  check(await p.isVisible('.recording'), 'Aufnahme-Dialog erscheint');
  await p.keyboard.press('Control+Shift+D');
  await p.waitForTimeout(150);
  check(!(await p.isVisible('.recording')), 'Aufnahme-Dialog schliesst nach dem Tastendruck');
  check((await p.textContent('[data-view=settings]')).includes('Strg+Umschalt+D'), 'Kürzel steht in der Liste');
  await p.click('.menu-item:has-text("Übersicht")');
  await p.keyboard.press('Control+Shift+D');
  await p.waitForTimeout(900);
  check((await consoleText()).includes('ipconfig /flushdns'), 'Strg+Umschalt+D führt „DNS-Cache leeren“ aus');

  // --- 3. Gefährliche Aktion per Kürzel: Dialog MUSS kommen ---------------------------------
  await goSettings();
  await p.click('.keys-panel .panel-right .tbtn');
  await p.selectOption('.keys-editor select', 'action.winsockReset');
  await p.click('.keys-editor .tbtn:has-text("Taste aufnehmen")');
  await p.keyboard.press('Alt+W');
  await p.waitForTimeout(150);
  await p.keyboard.press('Alt+W');
  await p.waitForTimeout(300);
  const dlg = await p.textContent('.dialog .panel-title').catch(() => '');
  check(/ADMINISTRATOR/.test(dlg), `Winsock per Kürzel ohne Admin → Admin-Dialog statt Ausführung (${dlg})`);
  await p.keyboard.press('Escape');
  check(!(await consoleText()).includes('netsh winsock reset'), 'Winsock wurde NICHT ausgeführt');
  check(await p.isVisible('[data-view=actions]'), 'Kürzel springt wie die Palette auf die Seite der Aktion');
  await goSettings();

  // --- 4. Verbotene Kombinationen und Konflikte ----------------------------------------------
  await p.click('.keys-panel .panel-right .tbtn');
  await p.selectOption('.keys-editor select', 'test.health');
  for (const [key, expect] of [['Control+c', 'Kopieren'], ['Control+k', 'Befehlspalette'], ['F7', 'fest vergeben'], ['h', 'Strg oder Alt'], ['Control+Alt+q', 'AltGr']]) {
    await p.click('.keys-editor .tbtn:has-text("Taste aufnehmen")');
    await p.keyboard.press(key);
    await p.waitForTimeout(120);
    const m = await p.textContent('.keys-msg');
    check(m.includes(expect), `${key} abgelehnt: „${m.slice(0, 70)}…“`);
  }
  // Escape bricht ab
  await p.click('.keys-editor .tbtn:has-text("Taste aufnehmen")');
  await p.keyboard.press('Escape');
  await p.waitForTimeout(100);
  check((await p.textContent('.keys-msg')).includes('abgebrochen'), 'Esc bricht die Aufnahme ab');
  // Konflikt: Alt+W ist schon Winsock
  await p.click('.keys-editor .tbtn:has-text("Taste aufnehmen")');
  await p.keyboard.press('Alt+W');
  await p.waitForTimeout(150);
  check((await p.textContent('.dialog .panel-title').catch(() => '')).includes('SCHON BELEGT'), 'Konflikt mit vorhandenem Kürzel wird gemeldet');
  await p.click('.dialog .tbtn:has-text("Ersetzen")');
  await p.waitForTimeout(150);
  const list = await p.textContent('.keys-list');
  check(list.includes('Health-Check') && !list.includes('Winsock'), 'Nach „Ersetzen“ startet Alt+W den Health-Check');

  // --- 5. Kürzel in der Palette sichtbar, aber nicht aktiv solange Palette offen ----------------
  await p.keyboard.press('Control+k');
  await p.keyboard.type('dns-cache leeren');
  check((await p.textContent('.pal-item.selected')).includes('Strg+Umschalt+D'), 'Palette zeigt das eigene Kürzel neben dem Befehl');
  const before = (await consoleText()).split('ipconfig /flushdns').length;
  await p.keyboard.press('Control+Shift+D');
  await p.waitForTimeout(400);
  check((await consoleText()).split('ipconfig /flushdns').length === before, 'Kürzel feuert nicht, solange die Palette offen ist');
  await p.keyboard.press('Escape');

  // --- 6. Konsole mit Uhrzeit, Uhr in der Statusleiste, Cursor, Ping-Anzahl ---------------------
  await goSettings();
  await p.click('text=Uhrzeit vor jeder Zeile');
  await p.click('text=Uhr anzeigen');
  await p.click('text=Block-Cursor in Überschriften blinkt');
  await p.click('[data-view=settings] .tchoice:has-text("∞")');
  await p.keyboard.press('Control+Shift+D');
  await p.waitForTimeout(900);
  const lastCmd = await p.$$eval('.console-body .line-cmd', l => l[l.length - 1].textContent);
  check(/^\[\d{2}:\d{2}:\d{2}\] > ipconfig \/flushdns/.test(lastCmd), `Konsolenzeile mit Uhrzeit: „${lastCmd}“`);
  check(/\d{2}:\d{2}:\d{2}/.test(await p.textContent('.sb-clock')), 'Uhr in der Statusleiste läuft');
  check(await p.evaluate(() => document.documentElement.classList.contains('no-blink') && getComputedStyle(document.querySelector('.cursor')).animationName === 'none'), 'Cursor blinkt nicht mehr');
  await p.click('.menu-item:has-text("Tests")'); await p.click('.ttab:has-text("Ping")');
  check((await p.textContent('[data-view=tests] .prompt-cmd')).startsWith('ping -t'), 'Ping-Test übernimmt die Anzahl ∞ (ping -t)');

  // --- 7. Export → Import auf "anderem PC" ------------------------------------------------------
  await goSettings();
  await p.click('.tbtn:has-text("In Zwischenablage kopieren")');
  const exported = await p.evaluate(() => navigator.clipboard.readText());
  check(JSON.parse(exported).settings.keybindings.length === 2, 'Export enthält die 2 Tastenkürzel');
  await p.evaluate(() => localStorage.clear()); await open(); await goSettings();
  check(!(await p.textContent('[data-view=settings]')).includes('Strg+Umschalt+D'), '„Neuer PC“: keine Kürzel vorhanden');
  const changed = JSON.parse(exported); changed.settings.theme = 'sepia'; changed.settings.fontSize = 99;
  await p.click('.backup-panel .tbtn:has-text("Importieren")');
  await p.fill('.tarea', 'kein json');
  await p.click('.backup-panel .tbtn:text-is("Übernehmen")');
  check((await p.textContent('.backup-msg')).includes('kein gültiger'), 'Unsinn wird beim Import abgelehnt');
  await p.fill('.tarea', JSON.stringify(changed));
  await p.click('.backup-panel .tbtn:text-is("Übernehmen")');
  check((await p.textContent('.dialog')).includes('fontSize'), 'Import-Dialog nennt den ungültigen Wert (fontSize 99)');
  await p.click('.dialog .tbtn:has-text("Importieren")');
  await p.waitForTimeout(200);
  check(await p.evaluate(() => document.documentElement.dataset.theme) === 'sepia', 'Theme aus dem Import aktiv');
  check((await p.textContent('[data-view=settings]')).includes('Strg+Umschalt+D'), 'Tastenkürzel aus dem Import vorhanden');
  check(await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--fs').trim()) === '14px', 'ungültige Schriftgrösse → Standard (13 × Courier 1.05 = 14 px)');

  // --- 8. Monitor-Autostart nach Neustart -----------------------------------------------------------
  await p.click('text=Beim Start automatisch starten');
  await open();
  await p.waitForTimeout(800);
  check((await p.textContent('.statusbar')).includes('Monitor:'), 'Ping-Monitor läuft nach dem Neustart automatisch');

  // --- 9. Kürzel für Befehle, die main.ts erst später anmeldet (Kompaktmodus) ---------------------
  await goSettings();
  await p.click('.keys-panel .panel-right .tbtn');
  await p.selectOption('.keys-editor select', 'app.compact');
  await p.click('.keys-editor .tbtn:has-text("Taste aufnehmen")');
  await p.keyboard.press('F12');
  await p.waitForTimeout(150);
  await open(); await goSettings();
  check(!(await p.textContent('.keys-list')).includes('unbekannt'), 'nach Neustart kein „unbekannter Befehl“ (Registry-Reihenfolge)');
  await p.keyboard.press('F12'); await p.waitForTimeout(300);
  check(await p.evaluate(() => document.body.classList.contains('compact')), 'F12 schaltet den Kompaktmodus ein');
  await p.keyboard.press('F12'); await p.waitForTimeout(300);
  check(!(await p.evaluate(() => document.body.classList.contains('compact'))), 'F12 schaltet ihn wieder aus');

  // --- 10. Zurücksetzen löscht auch Kürzel ---------------------------------------------------------
  await goSettings();
  await p.click('.tbtn:has-text("Auf Standard zurücksetzen")');
  await p.click('.dialog .tbtn:has-text("Zurücksetzen")');
  await p.waitForTimeout(200);
  check(!(await p.textContent('[data-view=settings]')).includes('Strg+Umschalt+D') && await p.evaluate(() => document.documentElement.dataset.theme) === 'cyan', 'Zurücksetzen: Standard-Theme, keine Kürzel');

  if (errors.length) { console.log('JS-FEHLER:', errors); fails++; }
  console.log(fails ? `\n${fails} FEHLGESCHLAGEN` : '\nAlle E2E-Prüfungen bestanden');
  await b.close();
  process.exit(fails ? 1 : 0);
})();
