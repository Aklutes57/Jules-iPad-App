#!/usr/bin/env python3
"""Generate the "Jules for iPad" app icons.

Usage
-----
    python3 -m pip install pillow      # one-time
    python3 tools/gen_icons.py         # rewrites everything in ./icons/

Output (written next to this script's parent, i.e. <repo>/icons/):

    icon-180.png            full-bleed 180x180  -> <link rel="apple-touch-icon">
    icon-192.png            rounded    192x192  -> manifest, purpose "any"
    icon-512.png            rounded    512x512  -> manifest, purpose "any"
    icon-512-maskable.png   full-bleed 512x512  -> manifest, purpose "maskable"

Design
------
A rounded square filled with a two-stop vertical indigo -> violet gradient,
carrying a white geometric "J": a horizontal top bar, a vertical stem, and a
half-circle hook.

The mark is built entirely from drawn primitives (two rectangles, one arc, one
circle for the round cap) -- deliberately NO text and NO font files, so the art
reproduces identically on any machine instead of depending on whatever fonts
happen to be installed.

Everything is drawn on a supersampled canvas and downsampled with LANCZOS,
which is what gives the curves their smooth edges.

"Full-bleed" icons are opaque RGB right to the edge with square corners:
iOS applies its own rounded mask to apple-touch-icon, and Android applies its
own (circle / squircle / teardrop) mask to maskable icons. Handing those
platforms pre-rounded art with transparent corners is what produces the classic
black-cornered home screen icon, so we don't.
"""

from __future__ import annotations

import os
import sys

try:
    from PIL import Image, ImageDraw
except ImportError:  # pragma: no cover - guidance for a fresh checkout
    sys.stderr.write(
        "Pillow is required to generate the icons.\n"
        "Install it with:  python3 -m pip install pillow\n"
    )
    raise SystemExit(1)


# --------------------------------------------------------------------------
# Look and feel
# --------------------------------------------------------------------------

GRADIENT_TOP = (99, 102, 241)      # #6366F1  indigo
GRADIENT_BOTTOM = (124, 58, 237)   # #7C3AED  violet
MARK_COLOR = (255, 255, 255)       # white "J"

# Apple's squircle is very close to 22.37% of the icon's edge length.
CORNER_RADIUS_RATIO = 0.2237

# How much of the icon's edge the mark's longest side takes up.
MARK_RATIO = 0.70            # normal icons
# Maskable icons get cropped by the platform to an arbitrary shape; anything
# outside the "safe zone" (the centred circle of 80% diameter) can be cut off.
# At 0.66 the J's top-right shoulder lands exactly on that circle, so we back
# off slightly to keep a real margin. Verified by verify_icons() below.
MASKABLE_MARK_RATIO = 0.63


# --------------------------------------------------------------------------
# The "J" mark, described in a 1000x1000 design grid
# --------------------------------------------------------------------------

_GRID = 1000     # design units per side
_MARK_SS = 4     # the mark is drawn at 4000x4000, then scaled down per icon

_STROKE = 132            # thickness of every limb of the J
_BAR_LEFT = 330          # left end of the top bar
_BAR_TOP = 184           # top edge of the top bar (and of the whole mark)
_STEM_LEFT = 634         # the stem is _STROKE wide, centred on x = 700
_STEM_RIGHT = 766
_STEM_BOTTOM = 600       # where the stem hands off to the hook
_HOOK_RADIUS = 220       # centre-line radius of the hook
_HOOK_CX = 480           # = _STEM_RIGHT - _STROKE / 2 - _HOOK_RADIUS
_HOOK_CY = 600           # = _STEM_BOTTOM, so the join is seamless


def render_mark() -> Image.Image:
    """Draw the geometric J and return it as a tightly cropped L-mode mask.

    White (255) is ink, black (0) is empty; the result is used as a paste mask
    so the same artwork can be stamped onto any background.
    """
    k = _MARK_SS
    canvas = Image.new("L", (_GRID * k, _GRID * k), 0)
    draw = ImageDraw.Draw(canvas)

    def box(*units: float) -> tuple:
        """Scale design units up to the supersampled canvas."""
        return tuple(u * k for u in units)

    half = _STROKE // 2

    # 1. Top bar. Rounding every corner gives the bar a pill-shaped left end
    #    and, because it stops at the stem's right edge, a nicely rounded
    #    top-right shoulder for the stem too.
    draw.rounded_rectangle(
        box(_BAR_LEFT, _BAR_TOP, _STEM_RIGHT, _BAR_TOP + _STROKE),
        radius=half * k,
        fill=255,
    )

    # 2. Vertical stem. Starts half a stroke down so it doesn't square off the
    #    rounded shoulders the bar just drew, and fills the notch under them.
    draw.rectangle(
        box(_STEM_LEFT, _BAR_TOP + half, _STEM_RIGHT, _STEM_BOTTOM),
        fill=255,
    )

    # 3. The hook: the bottom half of a ring. Pillow strokes an arc *inward*
    #    from its bounding box, so the box radius is the outer radius.
    outer = _HOOK_RADIUS + half
    draw.arc(
        box(_HOOK_CX - outer, _HOOK_CY - outer, _HOOK_CX + outer, _HOOK_CY + outer),
        start=0,      # 3 o'clock ... the arc runs clockwise through 6 o'clock
        end=180,      # ... and finishes at 9 o'clock
        fill=255,
        width=_STROKE * k,
    )

    # 4. Round cap on the free (upper-left) end of the hook.
    tip_x = _HOOK_CX - _HOOK_RADIUS
    draw.ellipse(
        box(tip_x - half, _HOOK_CY - half, tip_x + half, _HOOK_CY + half),
        fill=255,
    )

    bbox = canvas.getbbox()
    if bbox is None:  # pragma: no cover - would mean nothing was drawn
        raise RuntimeError("the J mark came out empty")
    return canvas.crop(bbox)


# --------------------------------------------------------------------------
# Icon assembly
# --------------------------------------------------------------------------

def _vertical_gradient(size: int) -> Image.Image:
    """A size x size RGB image fading GRADIENT_TOP -> GRADIENT_BOTTOM."""
    img = Image.new("RGB", (size, size))
    draw = ImageDraw.Draw(img)
    span = max(1, size - 1)
    for y in range(size):
        f = y / span
        draw.line(
            [(0, y), (size, y)],
            fill=tuple(
                int(round(GRADIENT_TOP[i] + (GRADIENT_BOTTOM[i] - GRADIENT_TOP[i]) * f))
                for i in range(3)
            ),
        )
    return img


def build_icon(size: int, mark: Image.Image, *, mark_ratio: float, rounded: bool) -> Image.Image:
    """Compose one icon at `size` x `size`.

    rounded=True  -> squircle corners, transparent outside them (RGBA)
    rounded=False -> full-bleed opaque square (RGB), for apple-touch-icon
                     and for maskable, where the platform does its own masking
    """
    ss = 4 if size >= 512 else 8      # keep the working canvas around 2k px
    work = size * ss

    canvas = _vertical_gradient(work).convert("RGBA")

    if rounded:
        corners = Image.new("L", (work, work), 0)
        ImageDraw.Draw(corners).rounded_rectangle(
            (0, 0, work - 1, work - 1),
            radius=int(round(work * CORNER_RADIUS_RATIO)),
            fill=255,
        )
        canvas.putalpha(corners)

    # Scale the mark so its longest side lands on `mark_ratio` of the icon.
    target = int(round(work * mark_ratio))
    scale = target / max(mark.width, mark.height)
    stamp = mark.resize(
        (max(1, int(round(mark.width * scale))), max(1, int(round(mark.height * scale)))),
        Image.LANCZOS,
    )

    ink = Image.new("RGBA", stamp.size, MARK_COLOR + (255,))
    canvas.paste(ink, ((work - stamp.width) // 2, (work - stamp.height) // 2), stamp)

    out = canvas.resize((size, size), Image.LANCZOS)
    return out if rounded else out.convert("RGB")


ICONS = (
    # filename,                size, mark ratio,           rounded
    ("icon-180.png",            180, MARK_RATIO,           False),
    ("icon-192.png",            192, MARK_RATIO,           True),
    ("icon-512.png",            512, MARK_RATIO,           True),
    ("icon-512-maskable.png",   512, MASKABLE_MARK_RATIO,  False),
)


def _safe_zone_usage(path: str) -> float:
    """Fraction of the icon's edge at which the outermost white pixel sits.

    Android crops maskable icons to an unknown shape and only guarantees the
    centred circle of 80% diameter, i.e. everything within 0.40 of the edge
    length from the centre. Returns that distance as a fraction so the caller
    can compare it against 0.40.
    """
    import math

    with Image.open(path) as src:
        img = src.convert("RGBA")
    width, height = img.size
    cx, cy = (width - 1) / 2, (height - 1) / 2
    worst = 0.0
    for x, y, (r, g, b, a) in (
        (x, y, img.getpixel((x, y))) for y in range(height) for x in range(width)
    ):
        if a > 200 and r > 230 and g > 230 and b > 230:   # opaque white ink
            worst = max(worst, math.hypot(x - cx, y - cy))
    return worst / width


def main() -> int:
    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    icon_dir = os.path.join(repo_root, "icons")
    os.makedirs(icon_dir, exist_ok=True)

    mark = render_mark()
    print(f"mark drawn at {mark.width}x{mark.height}, downsampled per icon\n")

    failures = []
    for name, size, ratio, rounded in ICONS:
        path = os.path.join(icon_dir, name)
        build_icon(size, mark, mark_ratio=ratio, rounded=rounded).save(path, "PNG", optimize=True)

        with Image.open(path) as check:
            got = check.size
            mode = check.mode
        if got != (size, size):
            failures.append(f"{name}: expected {size}x{size}, got {got[0]}x{got[1]}")
        print(
            f"  {name:<24} {got[0]}x{got[1]} {mode:<5} {os.path.getsize(path):>7,} bytes"
        )

    # The maskable icon is the only one with a hard geometric requirement.
    maskable = os.path.join(icon_dir, "icon-512-maskable.png")
    usage = _safe_zone_usage(maskable)
    print(f"\n  maskable safe zone: outermost ink at {usage * 100:.1f}% of edge (limit 40.0%)")
    if usage > 0.40:
        failures.append(
            f"icon-512-maskable.png: mark reaches {usage * 100:.1f}% of the edge, "
            "outside the 40% safe zone - lower MASKABLE_MARK_RATIO"
        )

    if failures:
        print("\nFAILED:")
        for problem in failures:
            print(f"  - {problem}")
        return 1

    print(f"\nWrote {len(ICONS)} icons to {icon_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
