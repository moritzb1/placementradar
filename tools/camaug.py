"""camaug.py – make a clean product photo look like a live webcam crop (brand model v2, part C of the 21 Nov plan).

A webcam frame differs from an Open Food Facts photo in predictable ways. Each function below imitates one of them;
`cam_view` chains a random selection. Used by train_brand_model_v2.py for training views (random) and for the
fixed "webcam test" (same seed per photo → identical test images in every run, before and after).

  geometry   : loose detector box (crop jitter), tilt, perspective (pack held at an angle)
  motion     : motion blur (pack moved while the shutter was open), defocus blur
  light      : brightness, contrast, colour cast (warm kitchen lamp / cold daylight), glare on foil and glossy print
  occlusion  : a hand holding the pack (skin-coloured palm + fingers over one edge)
  sensor     : low resolution (small box in a 720p frame), noise, strong JPEG compression
"""
import io, math, random

import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

GREY = (128, 128, 128)
SKIN = [(255, 219, 172), (241, 194, 125), (224, 172, 105), (198, 134, 66), (141, 85, 36), (92, 56, 30)]


def crop_jitter(img, r):
    w, h = img.size
    f, g = r.uniform(0.72, 1.0), r.uniform(0.72, 1.0)
    cw, ch = int(w * f), int(h * g)
    x, y = r.randint(0, w - cw), r.randint(0, h - ch)
    img = img.crop((x, y, x + cw, y + ch))
    if r.random() < 0.3:  # box too large: some table/background around the pack
        p = int(max(img.size) * r.uniform(0.05, 0.2))
        bg = Image.new("RGB", (img.width + 2 * p, img.height + 2 * p), tuple(r.randint(40, 220) for _ in range(3)))
        bg.paste(img, (p, p)); img = bg
    return img


def _coeffs(src, dst):
    """perspective coefficients mapping dst quad → src quad (PIL convention)"""
    A, B = [], []
    for (x, y), (u, v) in zip(dst, src):
        A += [[x, y, 1, 0, 0, 0, -u * x, -u * y], [0, 0, 0, x, y, 1, -v * x, -v * y]]
        B += [u, v]
    return np.linalg.solve(np.array(A, float), np.array(B, float)).tolist()


def perspective(img, r, strength=0.18):
    w, h = img.size
    d = lambda s: r.uniform(0, strength) * s
    dst = [(d(w), d(h)), (w - d(w), d(h)), (w - d(w), h - d(h)), (d(w), h - d(h))]
    return img.transform((w, h), Image.PERSPECTIVE, _coeffs([(0, 0), (w, 0), (w, h), (0, h)], dst), Image.BILINEAR, fillcolor=GREY)


def tilt(img, r):
    return img.rotate(r.uniform(-18, 18), expand=True, fillcolor=GREY, resample=Image.BILINEAR)


def motion_blur(img, r):
    a = np.asarray(img, dtype=np.float32)
    k = r.choice([3, 5, 7, 9, 11])
    ang = r.uniform(0, math.pi)
    dx, dy = math.cos(ang), math.sin(ang)
    acc = np.zeros_like(a)
    for i in range(k):
        t = i - k // 2
        acc += np.roll(np.roll(a, int(round(t * dy)), 0), int(round(t * dx)), 1)
    return Image.fromarray((acc / k).clip(0, 255).astype(np.uint8))


def defocus(img, r):
    return img.filter(ImageFilter.GaussianBlur(r.uniform(0.6, 2.0)))


def light(img, r):
    img = ImageEnhance.Brightness(img).enhance(r.uniform(0.5, 1.35))
    img = ImageEnhance.Contrast(img).enhance(r.uniform(0.72, 1.2))
    img = ImageEnhance.Color(img).enhance(r.uniform(0.7, 1.3))
    a = np.asarray(img, dtype=np.float32) * np.array([r.uniform(0.85, 1.15) for _ in range(3)], np.float32)  # colour cast
    return Image.fromarray(a.clip(0, 255).astype(np.uint8))


def glare(img, r):
    """specular highlight: a soft white ellipse (lamp reflected in foil / glossy print)"""
    w, h = img.size
    m = Image.new("L", (w, h), 0)
    cx, cy = r.uniform(0.1, 0.9) * w, r.uniform(0.1, 0.9) * h
    rx, ry = r.uniform(0.08, 0.35) * w, r.uniform(0.04, 0.2) * h
    ImageDraw.Draw(m).ellipse((cx - rx, cy - ry, cx + rx, cy + ry), fill=255)
    m = m.rotate(r.uniform(0, 180), center=(cx, cy)).filter(ImageFilter.GaussianBlur(max(2, min(rx, ry) * 0.6)))
    a = np.asarray(img, dtype=np.float32)
    k = (np.asarray(m, dtype=np.float32) / 255.0 * r.uniform(0.45, 0.9))[..., None]
    return Image.fromarray((a + k * (255 - a)).clip(0, 255).astype(np.uint8))


def hand(img, r):
    """a hand holding the pack: palm over one edge, 3–4 fingers reaching in (covers ~8–30 % of the crop)"""
    w, h = img.size
    img = img.copy()
    col = r.choice(SKIN)
    shade = tuple(int(c * 0.78) for c in col)
    m = Image.new("L", (w, h), 0); d = ImageDraw.Draw(m)
    side = r.choice("lrb")
    depth = r.uniform(0.12, 0.32)
    if side == "b":
        y0 = h * (1 - depth); x0 = r.uniform(0, 0.4) * w; x1 = x0 + r.uniform(0.35, 0.6) * w
        d.ellipse((x0, y0, x1, h + depth * h), fill=255)
        for i in range(r.randint(3, 4)):
            fx = x0 + (x1 - x0) * (i + 0.5) / 4; fw = (x1 - x0) / 5.5
            d.rounded_rectangle((fx - fw / 2, y0 - r.uniform(0.05, 0.18) * h, fx + fw / 2, y0 + 0.1 * h), radius=fw / 2, fill=255)
    else:
        xa = 0 if side == "l" else w * (1 - depth); xb = w * depth if side == "l" else w
        y0 = r.uniform(0.2, 0.6) * h; y1 = y0 + r.uniform(0.25, 0.4) * h
        d.ellipse((xa - (xb - xa) * 0.4, y0, xb, y1), fill=255)
        for i in range(r.randint(3, 4)):
            fy = y0 + (y1 - y0) * (i + 0.5) / 4; fh = (y1 - y0) / 5.5; L = r.uniform(0.06, 0.2) * w
            fx0, fx1 = (xb - 0.05 * w, xb + L) if side == "l" else (xa - L, xa + 0.05 * w)
            d.rounded_rectangle((fx0, fy - fh / 2, fx1, fy + fh / 2), radius=fh / 2, fill=255)
    m = m.filter(ImageFilter.GaussianBlur(1.2))
    skin = Image.new("RGB", (w, h), col)
    sd = ImageDraw.Draw(skin)  # a little shading so it is not a flat sticker
    for i in range(6):
        xs, ys = sorted((r.uniform(0, w), r.uniform(0, w))), sorted((r.uniform(0, h), r.uniform(0, h)))
        sd.ellipse((xs[0], ys[0], xs[1], ys[1]), fill=shade)
    skin = skin.filter(ImageFilter.GaussianBlur(max(w, h) / 12))
    img.paste(skin, (0, 0), m)
    return img


def sensor(img, r, strong=False):
    s = r.uniform(60, 130) if strong else r.uniform(90, 230)   # px of the long side of the box in the camera frame
    f = s / max(img.size)
    if f < 1:
        img = img.resize((max(8, int(img.width * f)), max(8, int(img.height * f))), Image.BILINEAR)
    if r.random() < 0.5:
        a = np.asarray(img, dtype=np.float32) + np.random.default_rng(r.randint(0, 1 << 30)).normal(0, r.uniform(2, 8), (img.height, img.width, 3))
        img = Image.fromarray(a.clip(0, 255).astype(np.uint8))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=r.randint(20, 45) if strong else r.randint(30, 75))
    return Image.open(buf).convert("RGB")


def cam_view(img, r, strong=False):
    """one random webcam-like view of a product photo"""
    img = img.convert("RGB")
    if max(img.size) > 360:
        img.thumbnail((360, 360))
    img = crop_jitter(img, r)
    if r.random() < 0.5: img = perspective(img, r)
    if r.random() < 0.4: img = tilt(img, r)
    if r.random() < 0.35: img = hand(img, r)
    if r.random() < 0.3: img = glare(img, r)
    img = light(img, r)
    if r.random() < 0.3: img = motion_blur(img, r)
    elif r.random() < 0.4: img = defocus(img, r)
    return sensor(img, r, strong) if r.random() < 0.85 else img


def cam_test(img, seed):
    """fixed webcam test view: same photo + same seed → same image in every run"""
    return cam_view(img, random.Random(seed), strong=True)


if __name__ == "__main__":  # python tools/camaug.py <photo> <out dir>: writes 12 example views (for the docs)
    import sys
    from pathlib import Path
    src, out = Image.open(sys.argv[1]), Path(sys.argv[2]); out.mkdir(parents=True, exist_ok=True)
    tiles = [cam_view(src, random.Random(i)) for i in range(11)]
    sheet = Image.new("RGB", (4 * 200, 3 * 200), (255, 255, 255))
    for i, t in enumerate([src.convert("RGB")] + tiles):
        t = t.copy(); t.thumbnail((190, 190)); sheet.paste(t, ((i % 4) * 200 + (200 - t.width) // 2, (i // 4) * 200 + (200 - t.height) // 2))
    sheet.save(out / "camaug_examples.jpg", quality=85)
    print(out / "camaug_examples.jpg")
