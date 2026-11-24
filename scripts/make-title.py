#!/usr/bin/env python3
"""ASCII-Titel der Übersicht neu erzeugen (nur Entwicklungswerkzeug).

    pip install pyfiglet
    python scripts/make-title.py

Schreibt assets/title.txt. Die App lädt die Datei per `?raw`-Import und
setzt sie mit textContent in ein <pre> – Backslashes bleiben so unverändert.
Gewählt: Font "slant" (getestet: slant, standard, small, smslant, doom, big).
"""
import pathlib
import pyfiglet

FONT = "slant"
TEXT = "NET-CONF"

art = pyfiglet.figlet_format(TEXT, font=FONT)
# Leerzeichen am Zeilenende und leere Zeilen oben/unten entfernen
lines = [line.rstrip() for line in art.splitlines()]
while lines and not lines[0]:
    lines.pop(0)
while lines and not lines[-1]:
    lines.pop()

width = max(len(line) for line in lines)
assert width <= 60 and len(lines) <= 7, f"zu gross: {width}x{len(lines)}"

out = pathlib.Path(__file__).resolve().parent.parent / "assets" / "title.txt"
out.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
print(f"{out} geschrieben ({width} x {len(lines)} Zeichen, Font {FONT})")
