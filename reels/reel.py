"""Cinematic reel compositor: real stock footage + green-screen app inserts + captions + ASMR foley.

Social / landing-page reels only. Never an App Store preview: Apple wants full-screen recordings (2.3.4).

python reels/reel.py reels/timelines/<app>.json <W> <H> <out.mp4> [--mute]
Footage and sound live in $LOBBY_STOCK (default ~/.cache/lobby/stock); `python reels/fetch.py` fills it.
"""
import json, math, os, re, subprocess, sys
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
    m = cv2.inRange(hsv, (35, 70, 70), (88, 255, 255))
    b, g, r = cv2.split(frame.astype(np.int16))
    m2 = ((g - np.maximum(r, b)) > 40).astype(np.uint8) * 255
    return cv2.bitwise_and(m, m2)


class Tracker:
    def __init__(self):
        self.q = None

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
        q = None
        for eps in np.linspace(0.01, 0.08, 15):
            a = cv2.approxPolyDP(hull, eps * peri, True)
            if len(a) == 4:
                q = order_quad(a); break
        if q is None:
            q = order_quad(cv2.boxPoints(cv2.minAreaRect(hull)))
        if self.q is not None:
            jump = np.abs(q - self.q).max()
            a = 0.55 if jump < frame.shape[1] * 0.08 else 1.0
            q = self.q * (1 - a) + q * a
        self.q = q
        return q, mc


def composite_green(frame, insert, tracker, glow=0.0):
    q, mc = tracker.quad(frame)
    if q is None:
        return frame
    H, W = frame.shape[:2]
    ih, iw = insert.shape[:2]
    src = np.array([[0, 0], [iw, 0], [iw, ih], [0, ih]], np.float32)
    # overscan the quad a little so the content reaches the rounded green edge
    c = q.mean(0); qq = c + (q - c) * 1.03
    M = cv2.getPerspectiveTransform(src, qq.astype(np.float32))
    warped = cv2.warpPerspective(insert, M, (W, H), flags=cv2.INTER_LINEAR)
    # key mask: closed green (fills thin tracking crosses) limited to the hull, keeps fingers
    k = max(7, W // 90) | 1
    mk = cv2.morphologyEx(green_mask(frame), cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    mk = cv2.dilate(mk, np.ones((3, 3), np.uint8))
    region = np.zeros_like(mk)
    cv2.fillConvexPoly(region, (c + (q - c) * 1.06).astype(np.int32), 255)
    mk = cv2.bitwise_and(mk, region)
    a = cv2.GaussianBlur(mk, (5, 5), 0).astype(np.float32)[..., None] / 255.0
    out = frame.astype(np.float32)
    # despill around edges
    band = cv2.dilate(mk, np.ones((k * 2 + 1, k * 2 + 1), np.uint8)) > 0
    bgr = out[band]
    bgr[:, 1] = np.minimum(bgr[:, 1], np.maximum(bgr[:, 0], bgr[:, 2]) * 1.02)
    out[band] = bgr
    w = warped.astype(np.float32)
    if glow:
        w = np.clip(w * (1 + glow), 0, 255)
    out = out * (1 - a) + w * a
    return out.astype(np.uint8)


def load_img(path):
    path = os.path.expanduser(path)
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
    return over(frame, np.array(tl))


# ---------- renderer ----------
def render(tl, W, H, out, mute=False, nocap=False, nocard=False):
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
    t0 = 0.0
    landscape = W > H
    for si, s in enumerate(segs):
        n = int(round(s["dur"] * FPS))
        tracker = Tracker()
        texts = {}
        for (off, name, vol) in s.get("sfx", []):
            cues.append((t0 + off, name, vol))
        ins = None
        if s.get("insert"):
            ins = load_img(s["insert"]) if not str(s["insert"]).isdigit() else None
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
                        ic = Clip.get(s["insert"]); insert = ic.at(s.get("iss", 0) + tt)
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
            elif s["t"] == "card":
                f = end_card(W, H, tt, s["dur"], app)
            else:
                raise ValueError(s["t"])
            # captions
            cap = s.get("cap")
            if cap:
                ca = min(1, tt / 0.25) * min(1, (s["dur"] - tt) / 0.2)
                if ca > 0:
                    k2 = round(ca, 2)
                    if k2 not in texts:
                        texts[k2] = text_layer(W, H, cap, hexrgb(app["accent"]), cap_pos(s, landscape), size=int(min(W, H) * (0.12 if not landscape else 0.085)), sub=s.get("sub"), appear=ca)
                    f = over(f, texts[k2])
            # transition in: flash / whip from previous
            tr = s.get("in", "cut")
            if prev_last is not None and i < 6 and tr != "cut":
                a = 1 - i / 6
                if tr == "flash":
                    f = np.clip(f.astype(np.float32) + 255 * a * 0.85, 0, 255).astype(np.uint8)
                elif tr == "whip":
                    sh = int(W * 0.35 * a)
                    blur = cv2.blur(prev_last, (max(1, int(80 * a)) | 1, 1))
                    f = cv2.addWeighted(np.roll(blur, -sh, axis=1), a, cv2.blur(f, (max(1, int(60 * a)) | 1, 1)), 1 - a, 0)
                elif tr == "fade":
                    f = cv2.addWeighted(prev_last, a, f, 1 - a, 0)
            if s["t"] != "card":
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
    mix_audio(tl, cues, total, out)


def cap_pos(s, landscape):
    return s.get("pos", "low")


def mix_audio(tl, cues, total, out):
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
    for (t, name, vol) in cues:
        inputs += ["-i", os.path.join(STOCK, "sfx", f"{name}.mp3")]
        filters.append(f"[{idx}:a]volume={vol},adelay={int(t * 1000)}|{int(t * 1000)}[c{idx}]")
        labels.append(f"[c{idx}]"); idx += 1
    filters.append(f"{''.join(labels)}amix=inputs={len(labels)}:normalize=0,atrim=0:{total:.2f},afade=t=out:st={total - 0.6:.2f}:d=0.6,"
                   f"acompressor=threshold=-14dB:ratio=3:attack=5:release=120,alimiter=limit=0.89,aresample=48000[a]")
    # inputs are offset by 1 because the video is input 0
    fc = ";".join(filters)
    fc = re.sub(r"\[(\d+):a\]", lambda m: f"[{int(m.group(1)) + 1}:a]", fc)
    cmd = [FFMPEG, "-v", "error", "-y", "-i", out + ".video.mp4"] + inputs + ["-filter_complex", fc, "-map", "0:v", "-map", "[a]",
                                                                              "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", out]
    subprocess.run(cmd, check=True)
    os.remove(out + ".video.mp4")


if __name__ == "__main__":
    tl = json.load(open(sys.argv[1]))
    W, H = int(sys.argv[2]), int(sys.argv[3])
    render(tl, W, H, sys.argv[4], mute="--mute" in sys.argv, nocap="--nocap" in sys.argv, nocard="--nocard" in sys.argv)
