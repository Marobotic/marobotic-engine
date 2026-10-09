#!/usr/bin/env python3
"""Vault icon: a red padlock with a gold keyhole, on the dark tile, 9x10 pixel grid and palette of
Hourglass and Funnel (CELL=36 per 512 px, rx=0.225, #121212 tile, #B14242 red, #F0BE66 gold), so the
apps read as one family. Writes the files Tauri's bundle asks for into src-tauri/icons/.
    #  -> red (the lock)   o -> gold (the keyhole)   . -> empty
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROWS = [
    "..#####..",
    ".#.....#.",  # the shackle
    ".#.....#.",
    ".#.....#.",
    "#########",  # the body
    "###ooo###",  # the keyhole: a wide top...
    "###ooo###",
    "####o####",  # ...and the slot under it
    "####o####",
    "#########",
]
BG, RED, GOLD = "#121212", "#B14242", "#F0BE66"
W, H, CELL = len(ROWS[0]), len(ROWS), 36
assert all(len(r) == W and r == r[::-1] for r in ROWS), "same width and left-right symmetric"

def png(size: int) -> Image.Image:
    ss = 4
    im = Image.new("RGBA", (size * ss, size * ss), (0, 0, 0, 0))
    ImageDraw.Draw(im).rounded_rectangle([0, 0, size * ss - 1, size * ss - 1], radius=int(size * ss * 0.225), fill=BG)
    im = im.resize((size, size), Image.LANCZOS)
    d = ImageDraw.Draw(im)
    c = max(1, round(size * CELL / 512))
    x0, y0 = (size - W * c) // 2, (size - H * c) // 2
    for r, row in enumerate(ROWS):
        for k, ch in enumerate(row):
            if ch != ".":
                d.rectangle([x0 + k * c, y0 + r * c, x0 + k * c + c - 1, y0 + r * c + c - 1], fill=GOLD if ch == "o" else RED)
    return im

out = Path(__file__).parent / "src-tauri" / "icons"
out.mkdir(parents=True, exist_ok=True)
for name, size in {"32x32.png": 32, "128x128.png": 128, "128x128@2x.png": 256, "icon.png": 512, "icon-1024.png": 1024}.items():
    png(size).save(out / name)
sizes = (16, 20, 24, 32, 40, 48, 64, 128, 256)      # each drawn on whole pixels, not downscaled
frames = [png(s) for s in sizes]
frames[-1].save(out / "icon.ico", format="ICO", sizes=[(s, s) for s in sizes], append_images=frames[:-1])
print("wrote", ", ".join(sorted(p.name for p in out.iterdir())))
