"""Fill $LOBBY_STOCK (default ~/.cache/lobby/stock) with the Mixkit footage and sound the timelines use.

Mixkit licence: free for commercial use, no attribution, no watermark; the raw clips may not be
redistributed on their own, so they stay in this local cache and never go in git.
"""
import html, os, re, sys, urllib.request

STOCK = os.path.expanduser(os.environ.get("LOBBY_STOCK", "~/.cache/lobby/stock"))
HERE = os.path.dirname(os.path.abspath(__file__))
UA = {"User-Agent": "Mozilla/5.0"}
# name -> (Mixkit sound-effects tag page, exact title)
SFX = {
    "rain_glass": ("rain", "Heavy rain on car glass interior"), "fire": ("fire", "Campfire crackles"),
    "click": ("click", "Cool interface click tone"), "tap": ("click", "On or off light switch tap"),
    "bubble": ("click", "Plastic bubble click"), "whoosh": ("whoosh", "Cinematic whoosh fast transition"),
    "whoosh2": ("whoosh", "Movie whoosh impact presentation"), "trailer": ("whoosh", "Epic movie trailer whoosh impact"),
    "engine": ("engine", "Engine slow spinning whoosh"), "rocket": ("whoosh", "Fast rocket whoosh"),
    "rocketland": ("whoosh", "Rocket landing whoosh"), "crowd": ("crowd", "Stadium joy shouting crowd"),
    "chant": ("crowd", "Crowd chanting at stadium"), "coins": ("coin", "Clinking coins"),
    "coins2": ("coin", "Coins handling"), "sparkle": ("whoosh", "Magic sparkle whoosh"),
    "roomtone": ("engine", "Cinematic room tone loop"), "achieve": ("coin", "Achievement completed"),
}


def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60).read()


def main():
    os.makedirs(f"{STOCK}/footage", exist_ok=True); os.makedirs(f"{STOCK}/sfx", exist_ok=True)
    for line in open(os.path.join(HERE, "footage.txt")):
        if not line.strip():
            continue
        vid = line.split()[1]
        dst = f"{STOCK}/footage/{vid}.mp4"
        if os.path.exists(dst):
            continue
        for q in ("1080", "720"):
            try:
                data = get(f"https://assets.mixkit.co/videos/{vid}/{vid}-{q}.mp4"); break
            except Exception:
                data = None
        if not data:
            sys.exit(f"footage {vid}: not found")
        open(dst, "wb").write(data); print("footage", vid, len(data))
    pages = {}
    for name, (tag, title) in SFX.items():
        dst = f"{STOCK}/sfx/{name}.mp3"
        if os.path.exists(dst):
            continue
        if tag not in pages:
            pages[tag] = get(f"https://mixkit.co/free-sound-effects/{tag}/").decode()
        url = None
        for block in pages[tag].split('data-controller="audio-player')[1:]:
            if html.escape(title) in block or title in html.unescape(block):
                m = re.search(r'preview-url-value="([^"]+)"', block)
                url = m and m.group(1); break
        if not url:
            sys.exit(f"sfx {name}: '{title}' not on /{tag}/")
        open(dst, "wb").write(get(url)); print("sfx", name)


if __name__ == "__main__":
    main()
