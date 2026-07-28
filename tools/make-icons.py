#!/usr/bin/env python3
"""Generate the extension's PNG icons (no third-party deps).

Draws a simple rounded "tag" glyph in Etsy orange on a transparent field.
Run:  python3 tools/make-icons.py
"""
import struct
import zlib
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent.parent / "extension" / "icons"
SIZES = (16, 32, 48, 128)

ORANGE = (241, 100, 30, 255)
ORANGE_DARK = (198, 76, 16, 255)
WHITE = (255, 255, 255, 255)
CLEAR = (0, 0, 0, 0)


def rounded_rect(x, y, w, h, radius, px, py):
    """True when point (px, py) is inside a rounded rectangle."""
    if not (x <= px <= x + w and y <= py <= y + h):
        return False
    cx = min(max(px, x + radius), x + w - radius)
    cy = min(max(py, y + radius), y + h - radius)
    return (px - cx) ** 2 + (py - cy) ** 2 <= radius ** 2 + 1e-9


def render(size):
    """Return a size*size list of RGBA tuples, supersampled 3x for smooth edges."""
    ss = 3
    pad = size * 0.06
    body = size - 2 * pad
    radius = body * 0.24
    # Price-tag hole + a magnifier bar suggest "search listings".
    hole_cx, hole_cy, hole_r = pad + body * 0.30, pad + body * 0.30, body * 0.10
    bar_x, bar_y = pad + body * 0.30, pad + body * 0.52
    bar_w, bar_h = body * 0.44, body * 0.10
    bar2_y = pad + body * 0.70
    bar2_w = body * 0.30

    pixels = []
    for y in range(size):
        for x in range(size):
            acc = [0.0, 0.0, 0.0, 0.0]
            for sy in range(ss):
                for sx in range(ss):
                    px = x + (sx + 0.5) / ss
                    py = y + (sy + 0.5) / ss
                    color = CLEAR
                    if rounded_rect(pad, pad, body, body, radius, px, py):
                        color = ORANGE
                        edge = body * 0.055
                        if not rounded_rect(pad + edge, pad + edge, body - 2 * edge,
                                            body - 2 * edge, radius * 0.8, px, py):
                            color = ORANGE_DARK
                        elif (px - hole_cx) ** 2 + (py - hole_cy) ** 2 <= hole_r ** 2:
                            color = WHITE
                        elif rounded_rect(bar_x, bar_y, bar_w, bar_h, bar_h / 2, px, py):
                            color = WHITE
                        elif rounded_rect(bar_x, bar2_y, bar2_w, bar_h, bar_h / 2, px, py):
                            color = WHITE
                    for i in range(4):
                        acc[i] += color[i]
            n = ss * ss
            pixels.append(tuple(int(round(c / n)) for c in acc))
    return pixels


def write_png(path, size, pixels):
    raw = bytearray()
    for y in range(size):
        raw.append(0)  # filter type 0
        for x in range(size):
            raw.extend(pixels[y * size + x])

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    path.write_bytes(png)


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        write_png(OUT_DIR / f"icon{size}.png", size, render(size))
        print(f"wrote icons/icon{size}.png")


if __name__ == "__main__":
    main()
