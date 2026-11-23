"""Cinematic reel compositor, free and local: generated (LTX-2.3) or stock plates with green screens, the app's
real simulator recordings tracked onto them (perspective, light spill, glass, motion blur, despill), word-by-word
captions, cuts snapped to the music's beat grid, foley placed at every logged tap, and the plates' own sound.

python reels/reel.py reels/timelines/<app>.json <W> <H> <out.mp4> [--mute] [--nocap] [--nocard] [--clean]
--clean (no grain/vignette) + reels/timelines/previews/* = App Store previews: full-screen recordings only (2.3.4).
"""
import json, math, os, subprocess, sys
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

STOCK = os.path.expanduser(os.environ.get("LOBBY_STOCK", "~/.cache/lobby/stock"))
FPS = 30
FONT_DIR = os.path.expanduser("~/Desktop/projects/build-log/brand/fonts")
FFMPEG = os.environ.get("FFMPEG", "ffmpeg")


def hexrgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def font(name, size):
    return ImageFont.truetype(os.path.join(FONT_DIR, name), size)


# ---------- sources ----------
class Clip:
    """Random-access-ish reader: frames at time t (seconds, source clock)."""
    cache = {}

    def __init__(self, path):
        self.path = path
        self.cap = cv2.VideoCapture(path)
        self.fps = self.cap.get(cv2.CAP_PROP_FPS) or 30
        self.n = int(self.cap.get(cv2.CAP_PROP_FRAME_COUNT))
        self.pos = -1
        self.last = None

    @classmethod
    def get(cls, src):
        src = os.path.expanduser(src)
        p = src if os.path.isabs(src) else os.path.join(STOCK, "footage", f"{src}.mp4")
        if p not in cls.cache:
            cls.cache[p] = Clip(p)
        return cls.cache[p]

    def at(self, t):
        i = max(0, min(self.n - 1, int(round(t * self.fps))))
        if i < self.pos or i > self.pos + 30:
            self.cap.set(cv2.CAP_PROP_POS_FRAMES, i)
            self.pos = i - 1
        while self.pos < i:
            ok, f = self.cap.read()
            if not ok:
                break
            self.pos += 1
            self.last = f
        return self.last


def cover(img, W, H, cx=0.5, cy=0.5, zoom=1.0):
    """Scale-to-cover crop with a focus point and extra zoom."""
    h, w = img.shape[:2]
    s = max(W / w, H / h) * zoom
    nw, nh = int(math.ceil(w * s)), int(math.ceil(h * s))
    r = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_LANCZOS4 if s > 1 else cv2.INTER_AREA)
    x = int(round((nw - W) * cx)); y = int(round((nh - H) * cy))
    x = max(0, min(nw - W, x)); y = max(0, min(nh - H, y))
    return r[y:y + H, x:x + W]


# ---------- grade ----------
def grade(f, kind):
    if kind == "none":
        return f
    f = f.astype(np.float32) / 255.0
    if kind == "teal":  # cool shadows, warm highlights
        lum = f.mean(axis=2, keepdims=True)
        shadow = np.clip(1 - lum * 2, 0, 1); hi = np.clip(lum * 2 - 1, 0, 1)
        f = f + shadow * np.array([0.05, 0.02, -0.02]) + hi * np.array([-0.03, 0.0, 0.04])  # BGR
    elif kind == "warm":
        f = f * np.array([0.88, 0.97, 1.08])
    elif kind == "night":
        f = f * np.array([1.08, 0.97, 0.9])
    elif kind == "moon":
        f = f * np.array([1.1, 0.98, 0.95])
    # gentle S-curve + slight crush
    f = np.clip(f, 0, 1)
    f = f * f * (3 - 2 * f) * 0.35 + f * 0.65
    return np.clip(f * 255, 0, 255).astype(np.uint8)


def vignette(W, H, strength=0.45):
    y, x = np.ogrid[:H, :W]
    d = np.sqrt(((x - W / 2) / (W / 2)) ** 2 + ((y - H / 2) / (H / 2)) ** 2) / math.sqrt(2)
    v = 1 - strength * np.clip(d, 0, 1) ** 2.2
    return v[..., None].astype(np.float32)


# ---------- green screen ----------
def order_quad(pts):
    pts = pts.reshape(-1, 2).astype(np.float32)
    s = pts.sum(1); d = np.diff(pts, axis=1).ravel()
    return np.array([pts[np.argmin(s)], pts[np.argmin(d)], pts[np.argmax(s)], pts[np.argmax(d)]], np.float32)


def green_mask(frame):
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    # generated plates render "chroma green" anywhere from lime (H~37) to mint (H~80), and less pure than a studio screen
    m = cv2.inRange(hsv, (30, 60, 60), (90, 255, 255))
    b, g, r = cv2.split(frame.astype(np.int16))
    m2 = ((g - np.maximum(r, b)) > 22).astype(np.uint8) * 255
    return cv2.bitwise_and(m, m2)


class Tracker:
    def __init__(self):
        self.q = None
        self.hist = []

    def velocity(self):
        if len(self.hist) < 2:
            return (0.0, 0.0)
        d = self.hist[-1] - self.hist[-2]
        return (float(d[0]), float(d[1]))

    def quad(self, frame):
        m = green_mask(frame)
        k = max(5, frame.shape[1] // 120) | 1
        mc = cv2.morphologyEx(m, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (k, k)))
        cs, _ = cv2.findContours(mc, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not cs:
            return self.q, mc
        A = frame.shape[0] * frame.shape[1]
        def score(c):
            a = cv2.contourArea(c)
            if a < A * 0.004:
                return -1
            (cx, cy), (w, h), _ = cv2.minAreaRect(c)
            fill = a / max(1, w * h)
            ar = max(w, h) / max(1, min(w, h))
            shape = 1.0 if 1.3 < ar < 2.6 else 0.3
            near = 1.0
            if self.q is not None:
                d = np.hypot(*(self.q.mean(0) - (cx, cy))) / frame.shape[1]
                near = 1.0 / (1 + 8 * d)
            return a * fill ** 3 * shape * near
        c = max(cs, key=score)
        if score(c) <= 0:
            return self.q, mc
        hull = cv2.convexHull(c)
        peri = cv2.arcLength(hull, True)
        cands = []
        for eps in np.linspace(0.01, 0.08, 15):
            a = cv2.approxPolyDP(hull, eps * peri, True)
            if len(a) == 4:
                cands.append(order_quad(a)); break
        cands.append(order_quad(cv2.boxPoints(cv2.minAreaRect(hull))))
        # rounded screens fool corner fitting: keep the quad that best overlaps the green region
        hm = np.zeros(mc.shape, np.uint8); cv2.fillConvexPoly(hm, hull.astype(np.int32), 1)
        def iou(qd):
            qm = np.zeros(mc.shape, np.uint8); cv2.fillConvexPoly(qm, qd.astype(np.int32), 1)
            return (qm & hm).sum() / max(1, (qm | hm).sum())
        q = max(cands, key=iou)
        if self.q is not None:
            jump = np.abs(q - self.q).max()
            a = 0.55 if jump < frame.shape[1] * 0.08 else 1.0
            q = self.q * (1 - a) + q * a
        self.q = q
        self.hist = (self.hist + [q.mean(0)])[-3:]
        return q, mc


def composite_green(frame, insert, tracker, glow=0.0, spill=0.22, glass=0.07, soften=0.7):
    """Key the green screen and put `insert` on it, with the cues that sell it as real:
    screen light spilling onto hands/face, a glass reflection that stays fixed to the device,
    motion blur from the tracked movement, and lens softness matched to the plate."""
    q, mc = tracker.quad(frame)
    if q is None:
        return frame
    H, W = frame.shape[:2]
    ih, iw = insert.shape[:2]
    src = np.array([[0, 0], [iw, 0], [iw, ih], [0, ih]], np.float32)
    c = q.mean(0); qq = c + (q - c) * 1.03  # overscan to reach the rounded green edge
    M = cv2.getPerspectiveTransform(src, qq.astype(np.float32))
    # downsample with area filtering first so the warp never aliases, then match the plate's softness
    qw = max(8.0, float(np.linalg.norm(q[1] - q[0])))
    ins = cv2.resize(insert, (max(8, int(qw * 2)), max(8, int(qw * 2 * ih / iw))), interpolation=cv2.INTER_AREA) if iw > qw * 2 else insert
    ih2, iw2 = ins.shape[:2]
    M = cv2.getPerspectiveTransform(np.array([[0, 0], [iw2, 0], [iw2, ih2], [0, ih2]], np.float32), qq.astype(np.float32))
    warped = cv2.warpPerspective(ins, M, (W, H), flags=cv2.INTER_LINEAR)
    if soften:
        warped = cv2.GaussianBlur(warped, (0, 0), soften * 0.5)
    ih, iw = ih2, iw2
    # glass: a soft diagonal sheen in screen space, so it moves with the device
    if glass:
        gy, gx = np.mgrid[0:ih:8, 0:iw:8]
        band = np.exp(-(((gx / iw) + (gy / ih) * 0.55 - 0.55) / 0.16) ** 2)
        sheen = cv2.resize(band.astype(np.float32), (iw, ih))
        sw = cv2.warpPerspective(sheen, M, (W, H))
        warped = np.clip(warped.astype(np.float32) + sw[..., None] * 255 * glass, 0, 255)
    # motion blur along the device's movement this frame
    v = tracker.velocity()
    sp = float(np.hypot(*v)) if np.all(np.isfinite(v)) else 0.0
    if sp > 1.5:
        L = int(min(40, sp * 0.9)) | 1
        ker = np.zeros((L, L), np.float32)
        ang = math.atan2(v[1], v[0])
        cx = cy = L // 2
        for t in np.linspace(-L / 2, L / 2, L * 2):
            ker[int(round(cy + t * math.sin(ang))) % L, int(round(cx + t * math.cos(ang))) % L] = 1
        ker /= ker.sum()
        warped = cv2.filter2D(np.asarray(warped, np.float32), -1, ker)
    k = max(7, W // 90) | 1
    mk = cv2.morphologyEx(green_mask(frame), cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    mk = cv2.dilate(mk, np.ones((3, 3), np.uint8))
    region = np.zeros_like(mk)
    cv2.fillConvexPoly(region, (c + (q - c) * 1.06).astype(np.int32), 255)
    mk = cv2.bitwise_and(mk, region)
    a = cv2.GaussianBlur(mk, (5, 5), 0).astype(np.float32)[..., None] / 255.0
    out = frame.astype(np.float32)
    # despill: the plate's green screen lit nearby skin and edges green; neutralise it in a wide band
    bandm = cv2.dilate(mk, np.ones((k * 6 + 1, k * 6 + 1), np.uint8)) > 0
    bgr = out[bandm]
    lim = np.maximum(bgr[:, 0], bgr[:, 2]) * 1.02
    bgr[:, 1] = np.where(bgr[:, 1] > lim, lim + (bgr[:, 1] - lim) * 0.15, bgr[:, 1])
    out[bandm] = bgr
    # anything still strongly green inside the device outline is screen: let the insert cover it
    hullm = np.zeros_like(mk); cv2.fillConvexPoly(hullm, (c + (q - c) * 1.02).astype(np.int32), 255)
    mk = cv2.bitwise_or(mk, cv2.bitwise_and(hullm, cv2.dilate(green_mask(frame), np.ones((5, 5), np.uint8))))
    a = cv2.GaussianBlur(mk, (5, 5), 0).astype(np.float32)[..., None] / 255.0
    w = np.asarray(warped, np.float32)
    if glow:
        w = np.clip(w * (1 + glow), 0, 255)
    # light spill: the screen lights what is around and in front of it (screen blend)
    if spill:
        lit = cv2.resize(w * a, (W // 8, H // 8), interpolation=cv2.INTER_AREA)
        lit = cv2.GaussianBlur(lit, (0, 0), max(W, H) / 8 / 14)
        lit = cv2.resize(lit, (W, H), interpolation=cv2.INTER_LINEAR) * spill
        out = 255 - (255 - out) * (255 - lit) / 255
    out = out * (1 - a) + w * a
    return np.clip(np.nan_to_num(out, nan=0.0), 0, 255).astype(np.uint8)


def load_img(path):
    im = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    if im is None:
        raise FileNotFoundError(path)
    if im.ndim == 3 and im.shape[2] == 4:
        al = im[..., 3:4].astype(np.float32) / 255
        im = (im[..., :3].astype(np.float32) * al).astype(np.uint8)
    return im


# ---------- text ----------
def text_layer(W, H, lines, accent, pos="low", size=None, ink=(255, 255, 255), sub=None, appear=1.0):
    """lines: list of strings; *word* -> accent colour. Returns RGBA numpy."""
    size = size or int(W * 0.095)
    f = font("BigShouldersDisplay-Black.ttf", size)
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    lh = int(size * 1.0)
    total = lh * len(lines) + (int(size * 0.55) if sub else 0)
    if pos == "low":
        y0 = int(H * 0.74) - total
    elif pos == "mid":
        y0 = (H - total) // 2
    else:
        y0 = int(H * 0.12)
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0)); sd = ImageDraw.Draw(shadow)
    for li, line in enumerate(lines):
        parts = []
        for j, p in enumerate(line.split("*")):
            if p:
                parts.append((p, j % 2 == 1))
        widths = [d.textlength(p.upper(), font=f) for p, _ in parts]
        x = (W - sum(widths)) / 2
        y = y0 + li * lh + (1 - appear) * size * 0.4
        for (p, acc), wd in zip(parts, widths):
            col = accent if acc else ink
            sd.text((x, y + size * 0.04), p.upper(), font=f, fill=(0, 0, 0, int(200 * appear)))
            d.text((x, y), p.upper(), font=f, fill=col + (int(255 * appear),), stroke_width=max(2, size // 40), stroke_fill=(0, 0, 0, int(140 * appear)))
            x += wd
    if sub:
        fs = font("InstrumentSans-Bold.ttf", int(size * 0.34))
        tw = d.textlength(sub, font=fs)
        y = y0 + lh * len(lines) + int(size * 0.12)
        sd.text(((W - tw) / 2, y + 3), sub, font=fs, fill=(0, 0, 0, int(200 * appear)))
        d.text(((W - tw) / 2, y), sub, font=fs, fill=ink + (int(235 * appear),))
    shadow = shadow.filter(ImageFilter.GaussianBlur(size // 10))
    return np.array(Image.alpha_composite(shadow, img))


def take_events(rec):
    """Touches and moments logged for a simulator recording (takes.json next to it)."""
    rec = os.path.expanduser(rec)
    tj = os.path.join(os.path.dirname(rec), "takes.json")
    if not os.path.exists(tj):
        return []
    d = json.load(open(tj))
    takes = d if isinstance(d, list) else d.get("takes", [])
    tk = next((x for x in takes if x.get("file") == os.path.basename(rec)), None)
    if not tk:
        return []
    ev = []
    for e in tk.get("timeline", []) + tk.get("events", []) + tk.get("taps_and_holds", []):
        ev.append((float(e["t"]), (e.get("type") or e.get("kind") or "tap").lower(), str(e.get("what") or e.get("action") or "")))
    for e in tk.get("moments", []):
        ev.append((float(e["t"]), "moment", str(e.get("event", ""))))
    return sorted(ev)


def auto_sfx(ev_kind, text):
    """Map a logged interaction to a foley sound (name, volume) or None."""
    t = text.lower()
    if ev_kind == "moment":
        if "thruster" in t or "jets" in t: return ("rocket", 0.45)
        if "touchdown" in t: return ("whoosh2", 0.6)
        if "airborne" in t or "let go" in t: return ("whoosh", 0.45)
        if "scored" in t or "score panel" in t: return ("achieve", 0.55)
        return None
    if ev_kind in ("tap", "press", "click"): return ("tap", 0.75)
    if ev_kind in ("drag", "swipe", "scroll", "slide"): return ("bubble", 0.35)
    return ("tap", 0.6)


def _ease_back(x):
    x = max(0.0, min(1.0, x)); c1 = 1.70158; c3 = c1 + 1
    return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2


def kinetic_layer(W, H, lines, accent, pos, size, t, out_a=1.0, ink=(255, 255, 255), stagger=0.09, pop=0.22):
    """Captions that land word by word: each word scales in from 135% with a slight overshoot."""
    f = font("BigShouldersDisplay-Black.ttf", size)
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    lh = int(size * 1.0)
    total = lh * len(lines)
    y0 = int(H * 0.74) - total if pos == "low" else ((H - total) // 2 if pos == "mid" else int(H * 0.12))
    probe = ImageDraw.Draw(img)
    wi = 0
    for li, line in enumerate(lines):
        words = []
        acc = False
        for j, chunk in enumerate(line.split("*")):
            for w in chunk.split():
                if words and not any(ch.isalnum() for ch in w):
                    pw, pa = words[-1]; words[-1] = (pw + w, pa)  # glue punctuation to the word before
                elif words and chunk[:1] not in (" ", "") and w is chunk.split()[0] and j > 0 and not line.split("*")[j - 1].endswith(" "):
                    pw, pa = words[-1]; words[-1] = (pw + w.upper(), pa)
                else:
                    words.append((w.upper(), j % 2 == 1))
        space = probe.textlength(" ", font=f)
        widths = [probe.textlength(w, font=f) for w, _ in words]
        x = (W - (sum(widths) + space * (len(words) - 1))) / 2
        for (w, acc), wd in zip(words, widths):
            p = (t - wi * stagger) / pop
            wi += 1
            if p <= 0:
                x += wd + space; continue
            sc = 1.35 - 0.35 * _ease_back(p)
            al = min(1.0, p * 2.5) * out_a
            fs = max(8, int(size * sc))
            fw = font("BigShouldersDisplay-Black.ttf", fs)
            tw = probe.textlength(w, font=fw)
            cx = x + wd / 2; cy = y0 + li * lh + size / 2
            tile = Image.new("RGBA", (int(tw + fs), int(fs * 1.6)), (0, 0, 0, 0))
            td = ImageDraw.Draw(tile)
            ox, oy = fs / 2, fs * 0.15
            td.text((ox, oy + fs * 0.05), w, font=fw, fill=(0, 0, 0, int(170 * al)))
            tile = tile.filter(ImageFilter.GaussianBlur(fs / 14))
            td = ImageDraw.Draw(tile)
            td.text((ox, oy), w, font=fw, fill=(accent if acc else ink) + (int(255 * al),),
                    stroke_width=max(2, fs // 38), stroke_fill=(0, 0, 0, int(150 * al)))
            img.alpha_composite(tile, (int(cx - tile.width / 2), int(cy - tile.height / 2)))
            x += wd + space
    return np.array(img)


def over(frame, rgba):
    a = rgba[..., 3:4].astype(np.float32) / 255
    rgb = rgba[..., :3][..., ::-1].astype(np.float32)
    return (frame.astype(np.float32) * (1 - a) + rgb * a).astype(np.uint8)


# ---------- end card ----------
def end_card(W, H, t, dur, app):
    bg = np.array(hexrgb(app["bg"])[::-1], np.float32)
    acc = hexrgb(app["accent"])
    frame = np.ones((H, W, 3), np.float32) * bg
    # radial glow
    y, x = np.ogrid[:H, :W]
    d = np.sqrt((x - W / 2) ** 2 + (y - H * 0.42) ** 2) / (min(W, H) * 0.6)
    pulse = 0.85 + 0.15 * math.sin(t * 3)
    g = np.clip(1 - d, 0, 1)[..., None] ** 2 * 0.55 * pulse
    frame = frame * (1 - g) + np.array(acc[::-1], np.float32) * g
    frame = frame.astype(np.uint8)
    ic = Image.open(os.path.expanduser(app["icon"])).convert("RGBA")
    s = int(min(W, H) * 0.34 * (0.92 + 0.08 * min(1, t / 0.5)))
    ic = ic.resize((s, s), Image.LANCZOS)
    mask = Image.new("L", (s, s), 0); ImageDraw.Draw(mask).rounded_rectangle((0, 0, s, s), radius=int(s * 0.225), fill=255)
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sh = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle(((W - s) // 2, int(H * 0.42) - s // 2 + 18, (W + s) // 2, int(H * 0.42) + s // 2 + 18), radius=int(s * 0.225), fill=(0, 0, 0, 150))
    sh = sh.filter(ImageFilter.GaussianBlur(28))
    layer.paste(ic, ((W - s) // 2, int(H * 0.42) - s // 2), mask)
    layer = Image.alpha_composite(sh, layer)
    frame = over(frame, np.array(layer))
    a = min(1, max(0, (t - 0.25) / 0.5))
    ink = hexrgb(app["ink"])
    f1 = font("BigShouldersDisplay-Black.ttf", int(min(W, H) * 0.12))
    f2 = font("InstrumentSans-Bold.ttf", int(min(W, H) * 0.042))
    f3 = font("DMMono-Medium.ttf", int(min(W, H) * 0.032))
    tl = Image.new("RGBA", (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(tl)
    y = int(H * 0.42) + s // 2 + int(min(W, H) * 0.06)
    for txt, f, col, gap in [(app["name"].upper(), f1, ink, 1.05), (app["tagline"], f2, ink, 1.6), ("ON THE APP STORE", f3, acc, 1.0)]:
        tw = d.textlength(txt, font=f)
        d.text(((W - tw) / 2, y + (1 - a) * 20), txt, font=f, fill=col + (int(255 * a),))
        y += int(f.size * gap) + 8
    disc = app.get("disclose")
    if disc:  # model licences (LTX-2) require generated content to be disclosed
        fd = font("DMMono-Regular.ttf", int(min(W, H) * 0.024))
        tw = d.textlength(disc, font=fd)
        d.text(((W - tw) / 2, int(H * 0.93)), disc, font=fd, fill=ink + (int(170 * a),))
    return over(frame, np.array(tl))


# ---------- renderer ----------
def beat_sync(tl):
    """Segments may give `beats` instead of `dur`: cuts then land on the music's real beat grid."""
    m = tl.get("music")
    if not m:
        return
    an = json.load(open(os.path.join(STOCK, "music", "analysis.json")))[m["track"]]
    st = m.get("start", an["start"])
    beats = [b - st for b in an["beats"] if b >= st - 1e-3]
    t = 0.0
    bi = 0
    for s in tl["segments"]:
        if "beats" in s:
            bi += s["beats"]
            end = beats[bi] if bi < len(beats) else t + s["beats"] * 60 / an["bpm"]
            s["dur"] = round(end - t, 4)
        else:
            end = t + s["dur"]
            bi = int(np.searchsorted(beats, end - 1e-3))
        t = end
    m["_start"] = st


def render(tl, W, H, out, mute=False, nocap=False, nocard=False, clean=False):
    beat_sync(tl)
    app = tl["app"]
    segs = [s for s in tl["segments"] if not (nocard and s["t"] == "card")]
    if nocap:
        segs = [{k: v for k, v in s.items() if k != "cap"} for s in segs]
    vig = vignette(W, H)
    rng = np.random.default_rng(7)
    grains = [rng.normal(0, 1, (H // 2, W // 2)).astype(np.float32) for _ in range(6)]
    cmd = [FFMPEG, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
           "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out + ".video.mp4"]
    ff = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    prev_last = None
    cues = []
    natives = []
    t0 = 0.0
    landscape = W > H
    for si, s in enumerate(segs):
        n = int(round(s["dur"] * FPS))
        tracker = Tracker()
        texts = {}
        for (off, name, vol) in s.get("sfx", []):
            cues.append((t0 + off, name, vol))
        if s.get("native_audio"):
            natives.append((t0, s["src"], s.get("ss", 0), s["dur"], s["native_audio"]))
        if s.get("auto_sfx", True):
            rec = s.get("insert") if s["t"] == "green" else s.get("src")
            if isinstance(rec, str) and "/recordings/" in rec:
                st = s.get("iss", 0) if s["t"] == "green" else s.get("ss", 0)
                sp = s.get("ispeed", 1.0) if s["t"] == "green" else s.get("speed", 1.0)
                for (et, kind, text) in take_events(rec):
                    off = (et - st) / sp + 0.12  # the app reacts ~0.15 s after the finger lands
                    if 0 <= off < s["dur"] - 0.1:
                        m = auto_sfx(kind, text)
                        if m: cues.append((t0 + off, m[0], m[1]))
        ins = None
        if s.get("insert"):
            si = str(s["insert"])
            ins = None if (si.isdigit() or si.endswith((".mp4", ".mov"))) else load_img(si)
        for i in range(n):
            u = i / max(1, n - 1)
            tt = i / FPS
            L = False
            if s["t"] in ("clip", "green"):
                L = landscape and "srcl" in s  # optional native-landscape source for 16:9 renders
                c = Clip.get(s["srcl"] if L else s["src"])
                f = c.at((s["ssl"] if L else s.get("ss", 0)) + tt * s.get("speed", 1.0))
                if s["t"] == "green":
                    if ins is not None:
                        insert = ins
                    else:
                        ic = Clip.get(s["insert"]); insert = ic.at(s.get("iss", 0) + tt * s.get("ispeed", 1.0))
                        insert = cover(insert, 900, 506) if s.get("tv") else insert
                    if s.get("scroll") and ins is not None:  # slow scroll inside long captures
                        hh = int(insert.shape[1] * 2.17)
                        if insert.shape[0] > hh:
                            yy = int((insert.shape[0] - hh) * u); insert = insert[yy:yy + hh]
                    f = composite_green(f, insert, tracker, s.get("glow", 0.0))
                z0, z1 = s.get("zooml", s.get("zoom", (1.0, 1.08))) if landscape else s.get("zoom", (1.0, 1.08))
                key = "xl" if landscape else "x"
                yv = s.get("yl", 0.5) if L and landscape else s.get("y", 0.5)
                f = cover(f, W, H, s.get(key, s.get("x", 0.5)), yv, z0 + (z1 - z0) * u)
                f = grade(f, s.get("grade", "teal"))
                if s.get("ev"):  # exposure in stops
                    f = np.clip(f.astype(np.float32) * (2 ** s["ev"]), 0, 255).astype(np.uint8)
            elif s["t"] == "card":
                f = end_card(W, H, tt, s["dur"], app)
            else:
                raise ValueError(s["t"])
            # captions
            cap = s.get("cap")
            if cap:
                out_a = min(1, (s["dur"] - tt) / 0.18)
                if out_a > 0:
                    f = over(f, kinetic_layer(W, H, cap, hexrgb(app["accent"]), cap_pos(s, landscape),
                                              int(min(W, H) * (0.12 if not landscape else 0.085)), tt - s.get("cap_at", 0.05), out_a))
            # transition in: flash / whip from previous
            tr = s.get("in", "cut")
            if prev_last is not None and i < 6 and tr != "cut":
                a = 1 - i / 6
                if tr == "flash":  # a quick exposure pop, not a white-out
                    a2 = a ** 2
                    f = np.clip(f.astype(np.float32) * (1 + 1.2 * a2) + 255 * a2 * 0.35, 0, 255).astype(np.uint8)
                elif tr == "whip":
                    sh = int(W * 0.35 * a)
                    blur = cv2.blur(prev_last, (max(1, int(80 * a)) | 1, 1))
                    f = cv2.addWeighted(np.roll(blur, -sh, axis=1), a, cv2.blur(f, (max(1, int(60 * a)) | 1, 1)), 1 - a, 0)
                elif tr == "fade":
                    f = cv2.addWeighted(prev_last, a, f, 1 - a, 0)
            if s["t"] != "card" and not clean:
                ff32 = f.astype(np.float32) * vig
                g = cv2.resize(grains[i % 6], (W, H), interpolation=cv2.INTER_NEAREST)
                ff32 += g[..., None] * 5.5
                f = np.clip(ff32, 0, 255).astype(np.uint8)
            # global fade from black at start
            if si == 0 and i < 8:
                f = (f.astype(np.float32) * (i / 8)).astype(np.uint8)
            ff.stdin.write(f.tobytes())
            last = f
        prev_last = last
        t0 += s["dur"]
    ff.stdin.close(); ff.wait()
    total = t0
    if mute:
        os.replace(out + ".video.mp4", out)
        return
    # drop near-duplicate cues (same sound within 0.25 s)
    cues.sort(); kept = []
    for c in cues:
        if not any(k[1] == c[1] and abs(k[0] - c[0]) < 0.25 for k in kept[-6:]):
            kept.append(c)
    mix_audio(tl, kept, total, out, natives)


def cap_pos(s, landscape):
    return s.get("pos", "low")


def mix_audio(tl, cues, total, out, natives=()):
    inputs, filters = [], []
    beds = tl.get("beds", [])
    idx = 0
    labels = []
    for b in beds:  # [name, start, end, vol]
        name, st, en, vol = b
        inputs += ["-stream_loop", "-1", "-i", os.path.join(STOCK, "sfx", f"{name}.mp3")]
        dur = en - st
        filters.append(f"[{idx}:a]atrim=0:{dur:.2f},asetpts=N/SR/TB,afade=t=in:d=0.6,afade=t=out:st={max(0, dur - 0.8):.2f}:d=0.8,volume={vol},adelay={int(st * 1000)}|{int(st * 1000)}[b{idx}]")
        labels.append(f"[b{idx}]"); idx += 1
    for (t, src, ss, dur, vol) in natives:  # a generated shot's own sound, under its picture
        inputs += ["-ss", f"{ss:.3f}", "-t", f"{dur:.3f}", "-i", os.path.expanduser(src) if os.path.isabs(os.path.expanduser(src)) else os.path.join(STOCK, "footage", f"{src}.mp4")]
        filters.append(f"[{idx}:a]asetpts=N/SR/TB,afade=t=in:d=0.08,afade=t=out:st={max(0, dur - 0.15):.2f}:d=0.15,volume={vol},adelay={int(t * 1000)}|{int(t * 1000)}[n{idx}]")
        labels.append(f"[n{idx}]"); idx += 1
    m = tl.get("music")
    if m:
        st = m.get("_start", 0)
        inputs += ["-ss", f"{st:.3f}", "-i", os.path.join(STOCK, "music", f"{m['track']}.mp3")]
        filters.append(f"[{idx}:a]atrim=0:{total:.2f},asetpts=N/SR/TB,afade=t=in:d=0.25,afade=t=out:st={max(0, total - 1.2):.2f}:d=1.2,volume={m.get('vol', 0.55)}[m{idx}]")
        labels.append(f"[m{idx}]"); idx += 1
    for (t, name, vol) in cues:
        inputs += ["-i", os.path.join(STOCK, "sfx", f"{name}.mp3")]
        filters.append(f"[{idx}:a]volume={vol},adelay={int(t * 1000)}|{int(t * 1000)}[c{idx}]")
        labels.append(f"[c{idx}]"); idx += 1
    filters.append(f"{''.join(labels)}amix=inputs={len(labels)}:normalize=0,atrim=0:{total:.2f},afade=t=out:st={total - 0.6:.2f}:d=0.6,"
                   f"acompressor=threshold=-14dB:ratio=3:attack=5:release=120,alimiter=limit=0.89,aresample=48000[a]")
    cmd = [FFMPEG, "-v", "error", "-y", "-i", out + ".video.mp4"] + inputs + [
        "-filter_complex", ";".join(f.replace(f"[{i}:a]", f"[{i + 1}:a]") if False else f for i, f in enumerate(filters)),
    ]
    # inputs are offset by 1 because the video is input 0
    fc = ";".join(filters)
    import re
    fc = re.sub(r"\[(\d+):a\]", lambda m: f"[{int(m.group(1)) + 1}:a]", fc)
    cmd = [FFMPEG, "-v", "error", "-y", "-i", out + ".video.mp4"] + inputs + ["-filter_complex", fc, "-map", "0:v", "-map", "[a]",
                                                                              "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", out]
    subprocess.run(cmd, check=True)
    os.remove(out + ".video.mp4")


if __name__ == "__main__":
    tl = json.load(open(sys.argv[1]))
    W, H = int(sys.argv[2]), int(sys.argv[3])
    render(tl, W, H, sys.argv[4], mute="--mute" in sys.argv, nocap="--nocap" in sys.argv, nocard="--nocard" in sys.argv, clean="--clean" in sys.argv)
