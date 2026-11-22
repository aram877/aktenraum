#!/usr/bin/env python3
"""Generate aktenraum's favicon / app icons from the "Stapel" logo (stdlib only).

The logo is three sheets: an indigo one (Arbeit) and an ochre one (Geld)
fanned out behind a white sheet with an ink outline, a green tab (Gesundheit)
and three text lines. Geometry is in a 64×64 box and must match
apps/web/app/components/AppLogo.vue (tests/unit/brand.spec.ts checks the SVG
output against it).

Small sizes get a simplified mark (no lines / tab, bolder outline), because
the full mark turns to mush at 16 px. Writes into apps/web/public/:

  favicon.svg            simplified mark, adaptive (dark colours under prefers-color-scheme: dark)
  favicon.ico            16 (simplified, no lines) / 32 / 48 px
  apple-touch-icon.png   180 px, full-bleed paper background (iOS rounds it)
  icon-192.png, icon-512.png, icon-maskable-512.png   for site.webmanifest

Run from the repo root:  python3 scripts/brand/make-icons.py
"""

from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parents[2] / "apps" / "web" / "public"

LIGHT = {"back": "#3f3f9a", "mid": "#9a6408", "front": "#fffdf9", "ink": "#1c1917", "tab": "#1f6b5c"}
DARK = {"back": "#5b5bc4", "mid": "#c08425", "front": "#211d1a", "ink": "#ede6da", "tab": "#5fbfa6"}
PAPER = "#f6f2ea"

# (x, y, w, h, radius, rotation in degrees, rotation centre)
BACK = (20, 7, 32, 42, 5, 9, (36, 28))
MID = (13, 11, 32, 42, 5, -7, (29, 32))
FRONT = (16, 14, 32, 42, 5)
TAB = (22, 20, 9, 3.4, 1.7)
LINES = ((22, 30, 42, 30), (22, 37, 42, 37), (22, 44, 34, 44))
STROKE = 2.6
STROKE_SMALL = 4.0


def rgb(hex_colour: str) -> tuple[int, int, int]:
    return tuple(int(hex_colour[i : i + 2], 16) for i in (1, 3, 5))  # type: ignore[return-value]


# --- signed distance functions (negative = inside) ------------------------------
def sd_round_rect(px: float, py: float, x: float, y: float, w: float, h: float, r: float) -> float:
    qx = abs(px - (x + w / 2)) - (w / 2 - r)
    qy = abs(py - (y + h / 2)) - (h / 2 - r)
    outside = math.hypot(max(qx, 0.0), max(qy, 0.0))
    return outside + min(max(qx, qy), 0.0) - r


def sd_rotated(px: float, py: float, spec: tuple) -> float:
    x, y, w, h, r, angle, (cx, cy) = spec
    a = math.radians(-angle)
    dx, dy = px - cx, py - cy
    lx = cx + dx * math.cos(a) - dy * math.sin(a)
    ly = cy + dx * math.sin(a) + dy * math.cos(a)
    return sd_round_rect(lx, ly, x, y, w, h, r)


def sd_capsule(px: float, py: float, x0: float, y0: float, x1: float, y1: float, r: float) -> float:
    vx, vy = x1 - x0, y1 - y0
    t = max(0.0, min(1.0, ((px - x0) * vx + (py - y0) * vy) / (vx * vx + vy * vy)))
    return math.hypot(px - x0 - t * vx, py - y0 - t * vy) - r


def colour_at(px: float, py: float, palette: dict[str, str], simple: bool) -> tuple[int, int, int] | None:
    """Painter's order; None = transparent."""
    out = None
    if sd_rotated(px, py, BACK) <= 0:
        out = rgb(palette["back"])
    if sd_rotated(px, py, MID) <= 0:
        out = rgb(palette["mid"])
    half = (STROKE_SMALL if simple else STROKE) / 2
    d = sd_round_rect(px, py, *FRONT)
    if d <= half:
        out = rgb(palette["ink"])
    if d <= -half:
        out = rgb(palette["front"])
        if not simple:
            if sd_round_rect(px, py, *TAB) <= 0:
                out = rgb(palette["tab"])
            for line in LINES:
                if sd_capsule(px, py, *line, STROKE / 2) <= 0:
                    out = rgb(palette["ink"])
    return out


def render(size: int, *, palette: dict[str, str], background: str | None, scale: float, simple: bool) -> bytes:
    """RGBA bytes; the 64-unit mark is drawn at `scale` of the canvas, centred."""
    ss = 3 if size >= 160 else 4 if size >= 64 else 8
    unit = size * scale / 64
    off = (size - 64 * unit) / 2
    bg = rgb(background) if background else None
    out = bytearray()
    n = ss * ss
    for y in range(size):
        for x in range(size):
            r = g = b = a = 0.0
            for sy in range(ss):
                for sx in range(ss):
                    px = ((x + (sx + 0.5) / ss) - off) / unit
                    py = ((y + (sy + 0.5) / ss) - off) / unit
                    c = colour_at(px, py, palette, simple) or bg
                    if c is not None:
                        r += c[0]
                        g += c[1]
                        b += c[2]
                        a += 1
            if a == 0:
                out += b"\x00\x00\x00\x00"
            else:
                out += bytes((round(r / a), round(g / a), round(b / a), round(255 * a / n)))
    return bytes(out)


# --- encoders -------------------------------------------------------------------
def png(size: int, rgba: bytes) -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + rgba[y * size * 4 : (y + 1) * size * 4] for y in range(size))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def ico(images: list[tuple[int, bytes]]) -> bytes:
    header = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries, blobs = b"", b""
    for size, data in images:
        entries += struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(data), offset)
        blobs += data
        offset += len(data)
    return header + entries + blobs


def svg_rect(spec: tuple, cls: str) -> str:
    x, y, w, h, r, angle, (cx, cy) = spec
    return f'<rect class="{cls}" x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" transform="rotate({angle} {cx} {cy})"/>'


def svg() -> str:
    """Simplified mark (favicon sizes), with dark colours via a media query."""
    x, y, w, h, r = FRONT

    def rules(p: dict[str, str]) -> str:
        return f".b{{fill:{p['back']}}}.m{{fill:{p['mid']}}}.f{{fill:{p['front']};stroke:{p['ink']}}}"

    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
        f"<style>{rules(LIGHT)}@media (prefers-color-scheme:dark){{{rules(DARK)}}}</style>"
        + svg_rect(BACK, "b")
        + svg_rect(MID, "m")
        + f'<rect class="f" x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" stroke-width="{STROKE_SMALL}"/>'
        + "</svg>\n"
    )


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "favicon.svg").write_text(svg(), encoding="utf-8")
    ico_images = [
        (16, png(16, render(16, palette=LIGHT, background=None, scale=1.0, simple=True))),
        (32, png(32, render(32, palette=LIGHT, background=None, scale=1.0, simple=False))),
        (48, png(48, render(48, palette=LIGHT, background=None, scale=1.0, simple=False))),
    ]
    (OUT / "favicon.ico").write_bytes(ico(ico_images))
    (OUT / "apple-touch-icon.png").write_bytes(
        png(180, render(180, palette=LIGHT, background=PAPER, scale=0.82, simple=False))
    )
    (OUT / "icon-192.png").write_bytes(png(192, render(192, palette=LIGHT, background=None, scale=1.0, simple=False)))
    (OUT / "icon-512.png").write_bytes(png(512, render(512, palette=LIGHT, background=None, scale=1.0, simple=False)))
    # Maskable: launchers crop to ~80 %, so keep the mark inside the safe zone.
    (OUT / "icon-maskable-512.png").write_bytes(
        png(512, render(512, palette=LIGHT, background=PAPER, scale=0.72, simple=False))
    )
    for name in ("favicon.svg", "favicon.ico", "apple-touch-icon.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png"):
        print(f"{name}: {(OUT / name).stat().st_size} bytes")


if __name__ == "__main__":
    main()
