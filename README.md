# Lobby

Store art for every native app: the frames in the App Store, Google Play, Amazon Appstore, Galaxy Store and
Alexa Skills Store, plus the web share card. It sits next to [Marquee](https://github.com/mutaaf/marquee) (ads)
and [Playbill](https://github.com/mutaaf/playbill) (search). Marquee sells the show, Playbill says what's
playing, and Lobby is the posters in the lobby.

The engine is deterministic and has zero dependencies: Node, headless Chrome, ffmpeg and sips. A Claude agent
supplies the judgment: the words, the order and the brand. It runs daily and wakes only when there's work.

## What it makes, per app

| Store | Targets |
|---|---|
| App Store | 6.9" iPhone (1320×2868), 13" iPad (2064×2752), iPhone Duo outer (1398×2034), 15–30 s app previews for iPhone (886×1920) and iPad (1200×1600) |
| Google Play | phone (1080×1920), 7" and 10" tablet, feature graphic (1024×500), hi-res icon (512) |
| Amazon Appstore | phone shots, promo image, icons 114 and 512 |
| Galaxy Store | phone shots, icon 512 |
| Alexa Skills Store | skill icons 108 and 512, skill card |
| Web | Open Graph card (1200×630) |

All sizes live in `specs/stores.json`; add a store by adding an entry.

What a set looks like:

- **One continuous backdrop runs across the set** (glows plus a ribbon), so the three frames a store shows
  in search results read as one poster.
- **Layouts:** `cover` (icon lockup and the hook), `hero`, `tilt`, `bleed` (full-height screen with a glass
  caption panel), `spotlight` (a magnifier on one control), `duo` (two screens).
- **Android frames** are neutral hardware: the iOS status bar is painted over with an Android one sampled
  from the screen, and a punch-hole camera is drawn.
- **Previews** use the real screen with no hardware frame (Apple's rule), a slow push-in and crossfades, and
  carry a silent stereo AAC track (Apple's processor wants one).

## Per-app input: `store/lobby.json` in the app's own repo

Semantics live in the app repo; the plumbing lives here (the same split as agent-fleet). See
`templates/lobby.json`. The fields:

- `brand`: `bg`, `bg2`, `ink`, `muted`, `accent`, `accent2`, `glow[]`, `display`/`body`/`mono` fonts and
  `texture` (`stars`, `field`, `grid`, `dots` or `scan`).
  - Fonts are Google Fonts family names (cached to `~/.cache/lobby/fonts`) or the app's own TTFs:
    `{ "files": { "800": "path.ttf" } }`.
- `raw.iphone` / `raw.ipad` / `raw.duo`: a folder of simulator captures, or `{ dir, prefix }`.
- `shots[]`: `raw` (capture id), `raw2` (for `duo`), `layout`, `kicker`, `title`, `sub`, `badge`,
  `focus: [cx, cy, width]` (for `spotlight`) and `stores` (limit a shot to some stores).
  - Caption markup: `*accent*`, `_highlighter_`, `|` for a line break.
- `bespoke`: `{"appstore/iphone-69": {dir, prefix}}` uses hand-made frames for that target (Hearth's App
  Store set).
- `audience: "kids"` turns on the kids rules. `avoid[]` lists trademarks the captions must never name.

Output goes to `store/lobby/out/<store>/<target>/` (gitignored, reproducible), with `sheet.png` (a contact
sheet) and `lobby-state.json`.

## Commands

```
bin/lobby status [--json]     every native app under ~/Desktop/projects: manifest, App Store state, work to do
bin/lobby init <app>          scaffold store/lobby.json
bin/lobby seed <app>          pull the current App Store screenshots as raw captures
bin/lobby build <app> [--only=play,appstore/iphone-69] [--no-preview]
bin/lobby push <app> [--dry-run]
bin/lobby build-all | push-all
./install.sh                  copy the engine to ~/.local/share/lobby and load launchd com.lobby.agent
```

`<app>` is a folder name under `~/Desktop/projects` or a path.

## The agent

`bin/lobby-cron` runs daily at 07:20 under launchd (`com.lobby.agent`). First it runs `lobby status --json`,
which costs no tokens. It wakes Claude (`prompts/agent.md`) only when one of these is true:

- a native app has no manifest (this is how future apps get picked up with no setup)
- a manifest or its captures changed
- an App Store version is editable and its current assets aren't uploaded yet

Sundays it also runs a full review pass. The job expires at `~/.local/share/lobby/SELF_CANCEL`, with a
notification, so it can never run on unwatched. Logs are in `~/.cache/lobby/`.

Discovery finds Xcode/XcodeGen projects, Expo configs, Capacitor, Android Gradle apps and Alexa skill
packages. `LOBBY_IGNORE` lists templates and copies (default:
`mobile-starter,18-0-demo,18-0-duo-graphics,lobby`).

## Pushing

- **App Store:** `~/.config/lobby/asc.env` (`ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_PATH`; the team key).
  - Uploads only to an editable version (Prepare for Submission, or Rejected). Never submits.
  - Uploads are idempotent: a set whose files and checksums match is left alone.
  - A version that's Waiting for Review, In Review or live is locked, so Lobby stages the assets and pushes
    on the next run after a new version opens.
- **Google Play:** `~/.config/lobby/play-service-account.json` (Android Publisher API: edits, upload,
  commit). Without it, assets stay staged.
- **Amazon, Galaxy, Alexa:** staged in `out/<store>` (no upload API wired; their consoles take the files as
  they are).

## Guardrails (lint, enforced before any upload)

- Exact pixel sizes and per-store screenshot counts.
- Preview length within 15–30 s.
- Ink on background contrast ≥ 4.5.
- No ranking, rating, count or award claims.
- No Apple names in Android-store frames, and no Android names in App Store frames.
- Each app's `avoid` list (trademarks).
- Kids apps: no buy, purchase, download or click CTAs, no URLs.
