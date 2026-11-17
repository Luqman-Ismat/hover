# Draws Hover's icons: a gold hextech hexagon around a glowing teal crystal.
# Writes the Mac app icon (.icns), menu bar / tray images and the phone home-screen icons.
# Run from the repo root: python3 scripts/icons.py  (needs Pillow; macOS for iconutil)
import math, os, subprocess, tempfile
from PIL import Image, ImageDraw, ImageFilter, ImageChops

S = 4  # supersampling
INK = (1, 10, 19)
GOLD_HI, GOLD, GOLD_DEEP = (240, 230, 210), (200, 170, 110), (120, 90, 40)
TEAL_HI, TEAL, TEAL_DEEP = (150, 255, 245), (10, 200, 185), (4, 90, 96)

def hexagon(cx, cy, r):
    return [(cx + r * math.cos(math.radians(a)), cy + r * math.sin(math.radians(a))) for a in range(-90, 270, 60)]

def diamond(cx, cy, w, h):
    return [(cx, cy - h / 2), (cx + w / 2, cy), (cx, cy + h / 2), (cx - w / 2, cy)]

def vgrad(size, top, bottom):
    g = Image.new('RGB', (1, 256))
    for y in range(256):
        t = y / 255
        g.putpixel((0, y), tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return g.resize(size)

def mask(size, draw):
    m = Image.new('L', size, 0)
    draw(ImageDraw.Draw(m))
    return m

def ring(size, cx, cy, r, width):
    outer = mask(size, lambda d: d.polygon(hexagon(cx, cy, r + width / 2), fill=255))
    inner = mask(size, lambda d: d.polygon(hexagon(cx, cy, r - width / 2), fill=255))
    return ImageChops.subtract(outer, inner)

def emblem(n, bg=True, squircle=True):
    """Full-colour icon at n×n pixels."""
    N = n * S
    img = Image.new('RGBA', (N, N), (0, 0, 0, 0))
    c = N / 2
    body = N * (824 / 1024) if squircle else N  # macOS icon grid leaves a margin
    if bg:
        m = mask((N, N), lambda d: d.rounded_rectangle([c - body / 2, c - body / 2, c + body / 2, c + body / 2], radius=body * 0.225 if squircle else 0, fill=255))
        base = vgrad((N, N), (12, 34, 48), INK).convert('RGBA')
        glow = Image.new('RGBA', (N, N), (0, 0, 0, 0))
        ImageDraw.Draw(glow).ellipse([c - body * 0.42, c - body * 0.42, c + body * 0.42, c + body * 0.42], fill=TEAL + (70,))
        base.alpha_composite(glow.filter(ImageFilter.GaussianBlur(body * 0.16)))
        img.paste(base, (0, 0), m)
        # hairline gold edge
        edge = ImageChops.subtract(m, mask((N, N), lambda d: d.rounded_rectangle([c - body / 2 + S * n / 256, c - body / 2 + S * n / 256, c + body / 2 - S * n / 256, c + body / 2 - S * n / 256], radius=body * 0.22 if squircle else 0, fill=255)))
        img.paste(Image.new('RGBA', (N, N), GOLD_DEEP + (255,)), (0, 0), edge)
    k = body / 824
    # outer gold hexagon
    gold = vgrad((N, N), GOLD_HI, GOLD_DEEP).convert('RGBA')
    gold2 = vgrad((N, N), GOLD, GOLD_DEEP).convert('RGBA')
    img.paste(gold, (0, 0), ring((N, N), c, c, 300 * k, 46 * k))
    inner = ring((N, N), c, c, 228 * k, 10 * k)
    img.paste(gold2, (0, 0), inner.point(lambda v: v * 0.75))
    # little gold studs on the top and bottom points
    for y in (c - 300 * k, c + 300 * k):
        img.paste(gold, (0, 0), mask((N, N), lambda d: d.polygon(diamond(c, y, 70 * k, 70 * k), fill=255)))
    # teal crystal with a glow
    crystal = mask((N, N), lambda d: d.polygon(diamond(c, c, 170 * k, 280 * k), fill=255))
    glow = Image.new('RGBA', (N, N), TEAL + (0,))
    glow.putalpha(crystal.filter(ImageFilter.GaussianBlur(40 * k)).point(lambda v: min(255, v * 1.4)))
    img.alpha_composite(glow)
    img.paste(vgrad((N, N), TEAL_HI, TEAL_DEEP).convert('RGBA'), (0, 0), crystal)
    # facet: the left half a touch lighter
    facet = mask((N, N), lambda d: d.polygon([(c, c - 140 * k), (c, c + 140 * k), (c - 85 * k, c)], fill=255))
    img.paste(Image.new("RGBA", (N, N), (255, 255, 255, 255)), (0, 0), facet.point(lambda v: v * 0.13))
    return img.resize((n, n), Image.LANCZOS)

def template(n):
    """Menu bar template: black shapes on transparent, macOS tints it for light/dark."""
    N = n * S
    c = N / 2
    k = N / 760
    a = ring((N, N), c, c, 330 * k, 64 * k)
    a = ImageChops.lighter(a, mask((N, N), lambda d: d.polygon(diamond(c, c, 200 * k, 330 * k), fill=255)))
    img = Image.new('RGBA', (N, N), (0, 0, 0, 0))
    img.putalpha(a)
    return img.resize((n, n), Image.LANCZOS)

def tray_color(n):
    """Windows tray: the emblem without the background, drawn a little heavier."""
    N = n * S
    c = N / 2
    k = N / 760
    img = Image.new('RGBA', (N, N), (0, 0, 0, 0))
    img.paste(vgrad((N, N), GOLD_HI, GOLD).convert('RGBA'), (0, 0), ring((N, N), c, c, 330 * k, 70 * k))
    img.paste(vgrad((N, N), TEAL_HI, TEAL).convert('RGBA'), (0, 0), mask((N, N), lambda d: d.polygon(diamond(c, c, 210 * k, 340 * k), fill=255)))
    return img.resize((n, n), Image.LANCZOS)

root = os.getcwd()
A = os.path.join(root, 'desktop', 'assets')
W = os.path.join(root, 'web')
template(18).save(os.path.join(A, 'trayTemplate.png'))
template(36).save(os.path.join(A, 'trayTemplate@2x.png'))
tray_color(16).save(os.path.join(A, 'tray.png'))
tray_color(32).save(os.path.join(A, 'tray@2x.png'))
emblem(512, squircle=False).convert('RGB').save(os.path.join(W, 'icon-512.png'))
emblem(180, squircle=False).convert('RGB').save(os.path.join(W, 'icon-180.png'))
emblem(256).save(os.path.join(A, 'icon.png'))  # window / Windows tray balloon
with tempfile.TemporaryDirectory() as t:
    iconset = os.path.join(t, 'Hover.iconset')
    os.mkdir(iconset)
    big = emblem(1024)
    for size in (16, 32, 128, 256, 512):
        for scale in (1, 2):
            big.resize((size * scale, size * scale), Image.LANCZOS).save(os.path.join(iconset, f'icon_{size}x{size}{"@2x" if scale == 2 else ""}.png'))
    subprocess.run(['iconutil', '-c', 'icns', iconset, '-o', os.path.join(A, 'Hover.icns')], check=True)
    big.save(os.path.join(root, 'docs', 'icon.png'))
print('icons written')
