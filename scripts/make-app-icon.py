#!/usr/bin/env python3
"""Draw the Honmaru AI app icon: the Figma tab-bar ring, at 1024.

The mark is the one the design file already uses in two places — the conic
("angular") gradient ring around the compose FAB, and the ring-and-dot the web
build ships as its favicon. This draws them as one thing, so the phone, the
browser tab and the tab bar are all the same object.

Rendered at 4x and downsampled: a conic gradient has no anti-aliasing of its
own, and the ring's edge is a circle, so both need supersampling to not look
like a screenshot of a jagged circle.
"""
from PIL import Image, ImageDraw
import math

S = 4                      # supersample
N = 1024 * S
BG = (14, 14, 16)          # Theme.Colors.background, dark
DOT = (0x66, 0x47, 0xF0)   # Theme.Colors.accent, light appearance

# The twelve stops of the Figma angular gradient, verbatim from the FAB
# (web-react/src/components/Dashboard.css). Position is a fraction of a turn
# measured from `from 180deg`, i.e. the bottom of the circle.
STOPS = [
    (0.00, 0x7D, 0x5B, 0xE7),
    (0.19, 0x7D, 0x5B, 0xE7),
    (0.28, 0xBC, 0x3F, 0xDA),
    (0.37, 0xFA, 0x24, 0xCE),
    (0.45, 0xFB, 0x49, 0xA5),
    (0.52, 0xFC, 0x6D, 0x7B),
    (0.55, 0xFD, 0x84, 0x61),
    (0.58, 0xFD, 0x9A, 0x46),
    (0.65, 0xF6, 0x87, 0xC6),
    (0.80, 0xA3, 0xA0, 0xE0),
    (0.95, 0x4F, 0xB9, 0xFA),
    (1.00, 0x00, 0x91, 0xFF),
]


def gradient(t):
    """Colour at fraction `t` of a turn, linearly interpolated between stops."""
    t = t % 1.0
    for i in range(len(STOPS) - 1):
        a, b = STOPS[i], STOPS[i + 1]
        if a[0] <= t <= b[0]:
            span = b[0] - a[0]
            k = 0.0 if span == 0 else (t - a[0]) / span
            return tuple(round(a[1 + c] + (b[1 + c] - a[1 + c]) * k) for c in range(3))
    return STOPS[-1][1:]


img = Image.new("RGB", (N, N), BG)
px = img.load()

cx = cy = N / 2
# Proportions follow the web favicon (r=150, stroke=28 on a 512 canvas), opened
# up slightly so the ring still reads at 40pt on a home screen.
r_outer = N * 0.335
r_inner = N * 0.250
r_dot = N * 0.118

# Only the annulus needs per-pixel work; everything else is flat.
lo, hi = int(cx - r_outer - 2), int(cx + r_outer + 2)
for y in range(lo, hi):
    dy = y - cy
    for x in range(lo, hi):
        dx = x - cx
        d = math.hypot(dx, dy)
        if r_inner <= d <= r_outer:
            # `from 180deg` in CSS starts at the bottom and runs clockwise.
            ang = (math.atan2(dx, dy) / (2 * math.pi)) % 1.0
            px[x, y] = gradient(ang)

# The dot is the FAB itself: one solid accent circle in the middle.
ImageDraw.Draw(img).ellipse(
    [cx - r_dot, cy - r_dot, cx + r_dot, cy + r_dot], fill=DOT
)

out = "TikTokForWork/Assets.xcassets/AppIcon.appiconset/AppIcon.png"
img.resize((1024, 1024), Image.LANCZOS).save(out, "PNG")
print("wrote", out)
