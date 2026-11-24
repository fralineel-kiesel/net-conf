"""Erzeugt das Platzhalter-Icon (app-icon.png, 1024x1024) für Net-Conf.

Aufruf:  python scripts/make-icon.py  &&  npx tauri icon app-icon.png
Benötigt: Pillow (pip install pillow) und eine Monospace-Schrift (TTF).
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont

SIZE = 1024
BG = (11, 15, 20, 255)          # fast schwarz
BORDER = (22, 78, 92, 255)     # dunkles Cyan
ACCENT = (34, 211, 238, 255)    # Cyan (#22d3ee)

FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/jetbrains-mono/JetBrainsMono-ExtraBold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
    "C:/Windows/Fonts/CascadiaMono.ttf",
    "C:/Windows/Fonts/consolab.ttf",
]


def load_font(px: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        if Path(path).exists():
            return ImageFont.truetype(path, px)
    sys.exit("Keine Monospace-Schrift gefunden – Pfad in FONT_CANDIDATES ergänzen.")


def main() -> None:
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    margin, radius = 64, 200
    box = (margin, margin, SIZE - margin, SIZE - margin)
    d.rounded_rectangle(box, radius=radius, fill=BG, outline=BORDER, width=14)

    font = load_font(440)
    text = ">_"
    l, t, r, b = d.textbbox((0, 0), text, font=font)
    x = (SIZE - (r - l)) / 2 - l
    y = (SIZE - (b - t)) / 2 - t

    # Glow: Text auf eigener Ebene zeichnen, weichzeichnen, darunterlegen.
    glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ImageDraw.Draw(glow).text((x, y), text, font=font, fill=ACCENT)
    glow = glow.filter(ImageFilter.GaussianBlur(28))
    img = Image.alpha_composite(img, glow)
    ImageDraw.Draw(img).text((x, y), text, font=font, fill=ACCENT)

    img.save("app-icon.png")
    print("app-icon.png geschrieben")


if __name__ == "__main__":
    main()
