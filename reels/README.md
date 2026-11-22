# Cinematic reels

Social (9:16, with ASMR foley) and landing-page (16:9 / 9:16, muted) reels for each app: free stock footage
of the real world, the app's real screens tracked into green-screen phones and TVs, captions, an icon end card.

**Never an App Store preview.** Apple wants previews to be full-screen recordings of the app (2.3.4; Hinge Pop
0.3.2 was rejected for a framed reel on 2026-11-21). These cuts include non-app footage, so they go to social
and the web only.

```
python3 -m venv ~/.cache/lobby/reels-venv && ~/.cache/lobby/reels-venv/bin/pip install -r reels/requirements.txt
python3 -I reels/fetch.py                       # Mixkit footage + sound into ~/.cache/lobby/stock (≈400 MB, once)
PY=~/.cache/lobby/reels-venv/bin/python
$PY reels/reel.py reels/timelines/hearth.json 1080 1920 out/hearth-9x16.mp4          # social, with sound
$PY reels/reel.py reels/timelines/hearth.json 1920 1080 out/hearth-16x9.mp4 --mute   # landing loop
```

A full 1080x1920 render takes about 2 minutes. Re-encode for delivery: social `-crf 21`, landing loops
1280x720 / 720x1280 `-crf 27 -an` (about 2 MB each).

## Timelines
`timelines/<app>.json`: `app` (name, tagline, colours, icon) + `beds` (`[sound, start, end, volume]`) +
`segments`, each one of:

| `t` | what | keys |
|---|---|---|
| `clip` | a stock shot | `src` (Mixkit id), `ss`, `dur`, `speed`, `x`/`xl` (crop focus, portrait/landscape), `y`, `zoom` [from, to], `grade` (teal, warm, night, moon) |
| `green` | a green-screen phone/TV with the app inside | as `clip`, plus `insert` (a screenshot path, or a footage id for video), `tv` (16:9 insert) |
| `card` | icon end card | `dur` |

A `clip` can also carry `srcl` / `ssl` / `zooml` / `yl`: a native-landscape source used only for 16:9 renders.
Flags: `--mute` (no audio), `--nocap` (no captions), `--nocard` (drop the end card): a landing backdrop behind
other UI wants `--mute --nocap --nocard`.

**Real brands:** some apps forbid real brand, product or vehicle likenesses (Cold Gas AGENTS.md §3.7, 17-0's
no-club-marks rule). Stock shots of real cars, rockets or branded helmets are out for those apps; use the
app's own gameplay clips instead (Cold Gas: `dist-clips/`, `store/portals/crazygames/`).

Every segment can have `cap` (lines; `*word*` takes the accent colour), `in` (cut, fade, whip, flash) and
`sfx` (`[offset, sound, volume]`). Look at a contact sheet of every render before shipping:
`ffmpeg -i out.mp4 -vf "fps=2,scale=180:-1,tile=10x4" -frames:v 1 sheet.jpg`.

## Footage and sound
Mixkit (mixkit.co): free for commercial use, no attribution, no watermark. The raw clips must not be
redistributed on their own, so they live only in the local cache and never in git. `footage.txt` lists the
clip ids and what each shows; `fetch.py` has the sound titles.

## Keying
`Tracker` picks the most phone-shaped green contour (fill, aspect, nearness to the last frame), so green
plants behind a phone are not keyed; the key is limited to the tracked screen. Thin tracking crosses on the
green screens are closed away; fingers in front of the screen stay in front.
