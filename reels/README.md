# Cinematic reels

Free, local, open-source reels for every app: photoreal scenes generated on this Mac (LTX-2.3), the app's
**real** simulator recordings tracked into the phones and TVs in those scenes, captions that land word by word,
cuts on the music's beat, and foley at every real tap. Three outputs per app:

| Output | Size | Where it goes |
|---|---|---|
| Social reel | 1080x1920, ~18 s, music + foley + scene sound, -14 LUFS | Reels, TikTok, Shorts |
| Landing loop | 1280x720 / 720x1280, muted (`--mute --nocap --nocard` for a backdrop) | the app's page |
| App Store preview | 886x1920, 15-30 s, `--clean`, recordings only, -16 LUFS | the next version in App Store Connect |

**App Store previews may only show the app** (Apple 2.3.4; Hinge Pop 0.3.2 was rejected for a framed reel on
2026-11-21). The preview timelines in `timelines/previews/` use only full-screen recordings: no generated or
stock shots, no captions, no end card, no grain.

## Pipeline

```
python3 -m venv ~/.cache/lobby/reels-venv && ~/.cache/lobby/reels-venv/bin/pip install -r reels/requirements.txt
PY=~/.cache/lobby/reels-venv/bin/python
python3 -I reels/fetch.py        # Mixkit stock footage + sound (free licence) → ~/.cache/lobby/stock
$PY reels/music.py               # beat grid + peak window per track → stock/music/analysis.json
reels/gen/run.sh                 # generate every shot in gen/shots.tsv → ~/.cache/lobby/gen/shots (≈8 min each)
$PY reels/reel.py reels/timelines/hearth.json 1080 1920 out/hearth-9x16.mp4
$PY reels/reel.py reels/timelines/previews/hearth.json 886 1920 out/hearth-preview.mp4 --clean
```
Then loudness-normalise: social `-af loudnorm=I=-14:TP=-1.5`, previews `I=-16`.

Recordings come from each app's simulator (`xcrun simctl io <udid> recordVideo`, status bar 9:41) into
`~/Movies/App Reels/recordings/<app>/` with a `takes.json` listing every tap/drag (`t` in seconds) and, for games,
logged moments (thrusters, touchdown, score). `reel.py` reads it and drops a tap, swipe, whoosh or score sound at
each one, 0.12 s after the finger lands (when the app reacts).

## Generated shots (gen/)
- Engine: [ltx-2-mlx](https://github.com/dgrauet/ltx-2-mlx) (MIT) with `dgrauet/ltx-2.3-mlx-q8`, `--distilled`,
  576x1024, 97 or 121 frames at 24 fps, native audio. The q8 pack downloads ~82 GB (it holds three
  transformer variants; only `distilled` is used) plus the Gemma 3 12B 4-bit text encoder.
- **Licence:** LTX-2 Community License. Free for entities under $10M annual revenue. Generated content must be
  clearly disclosed: every timeline sets `app.disclose`, which the end card prints.
- Prompt for a screen as "a perfectly flat, solid chroma-key green with nothing on it". The model renders it
  anywhere from lime to mint and less pure than a studio screen; the keyer allows for that.
- **It invents logos and lettering** (end-zone words, midfield emblems, ribbon boards) even when told not to.
  Look at every shot; for apps that forbid marks (17-0, Cold Gas) drop or crop the shot. The stadium shot was
  dropped for that reason.
- Keep people adult. Distilled mode takes no negative prompt.

## Timelines
`timelines/<app>.json`: `app` (name, tagline, colours, icon, `disclose`), `music` (`track`, `vol`), `beds`, and
`segments`. A segment gives `beats` (snapped to the track's beat grid) or `dur`, and is one of:

| `t` | what | keys |
|---|---|---|
| `clip` | a shot or a full-screen recording | `src`, `ss`, `speed`, `x`/`xl`, `y`, `zoom`, `grade` (teal, warm, night, moon, none), `ev`, `native_audio` (volume of the shot's own sound), `srcl`/`ssl`/`zooml`/`yl` (landscape source for 16:9) |
| `green` | a green screen with the app inside | as `clip`, plus `insert` (recording .mp4, screenshot, or footage id), `iss`, `ispeed`, `tv` |
| `card` | icon end card | |

Every segment can have `cap` (`*word*` = accent), `in` (cut, fade, whip, flash), `sfx` (`[offset, sound, vol]`)
and `auto_sfx: false` to skip foley from takes.json. `grade: "none"` keeps UI recordings colour-exact.

## Realism checklist (why v1 looked fake)
Stills inside phones → live recordings. Flat paste → light spill onto hands/faces, a glass sheen fixed to the
device, motion blur from the tracked movement, despill of the plate's green cast, plate-matched softness and
grain. 720p stock → generated plates lit for the scene. Static captions → word-by-word pop. Free-timed cuts → cuts
on the beat. Silence between taps → foley at every logged touch plus each plate's own room sound.

## Look before shipping
`ffmpeg -i out.mp4 -vf "fps=2,scale=180:-1,tile=10x4" -frames:v 1 sheet.jpg` and read every frame: keyed screens
(no leftover green), no invented logos or text, no real brands where the app forbids them, captions clear of UI.
