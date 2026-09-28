# Generates the app icon (build/icon.ico, resources/icon.png). Run: python scripts/make-icon.py
from PIL import Image, ImageDraw

S = 1024


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def make():
    base = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    grad = Image.new('RGBA', (S, S))
    px = grad.load()
    c1, c2 = (123, 110, 246), (200, 107, 255)
    for y in range(S):
        for x in range(S):
            t = (x + y) / (2 * S)
            px[x, y] = lerp(c1, c2, t) + (255,)
    mask = Image.new('L', (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([40, 40, S - 40, S - 40], radius=220, fill=255)
    base.paste(grad, (0, 0), mask)

    d = ImageDraw.Draw(base)
    # Scissors, drawn on the 24-unit grid of the Lucide icon used in the app.
    k, ox, oy = 30, S / 2 - 12 * 30, S / 2 - 12 * 30
    P = lambda x, y: (ox + x * k, oy + y * k)
    width = int(2.2 * k)
    white = (255, 255, 255, 255)
    for cx, cy in [(6, 6), (6, 18)]:
        r = 3 * k
        x, y = P(cx, cy)
        d.ellipse([x - r, y - r, x + r, y + r], outline=white, width=width)
    for a, b in [((20, 4), (8.12, 15.88)), ((14.47, 14.48), (20, 20)), ((8.12, 8.12), (12, 12))]:
        d.line([P(*a), P(*b)], fill=white, width=width)
        for pt in (a, b):
            x, y = P(*pt)
            r = width / 2
            d.ellipse([x - r, y - r, x + r, y + r], fill=white)
    return base


img = make()
img.resize((512, 512), Image.LANCZOS).save('resources/icon.png')
img.save('build/icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
img.resize((256, 256), Image.LANCZOS).save('build/icon.png')
print('ok')
