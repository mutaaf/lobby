# Lessons

What went wrong, and the rule that follows. The agent reads this at the start of every run.

- 2026-11-04: Parallel headless Chromes sharing a profile crash, and Chrome exits non-zero after writing a good PNG. Every render gets its own profile, and the file on disk decides success.
- 2026-11-04: `zoompan` emits frames per input frame, so looped stills made an 8-shot preview run 30.4 s, over Apple's limit. Feed each still once.
- 2026-11-04: Reinstalling the engine reloaded the job and killed a run in progress. install.sh leaves a running job alone.
- 2026-11-04: Discovery counted linked worktrees as separate apps. It now skips any folder whose `.git` is a file. There is a test.
- 2026-11-05: An iPad preview video was built from iPhone screens for an iPhone-only app and queued for upload. The target now needs the manifest's `ipad` flag, and push checks it too. There is a test.
- 2026-11-05: Status can show an app as rejected but not why. Rejection text is readable only signed in to App Store Connect, so check every app's thread before deciding one app's next step.
- 2026-11-09: A run recaptured Moon Club for 0.16.1 in `moon-club-lobby` and stopped before committing, so the next run saw "inputs changed" with nothing pushed. Before recapturing, check `git worktree list` for an unfinished `lobby/*` branch and finish it.
- 2026-11-09: The `cover` sticker sits at a fixed spot over the device's top right. On iPad it hid 17-0's "1 in 6,000" stat. Read the iPad cover too, and drop the badge when it hides something that matters.
- 2026-11-10: Moon Club showed "inputs changed" only because merging yesterday's recapture PR rewrote the raw files' mtimes (`inputsHash` uses size + mtime). Before recapturing, diff the app's commits since the last build: here 0.16.2 added a headline feature (living lesson cards) that no frame showed, so the run added a frame for it.
- 2026-11-10: `focus` is shared by the iPhone and iPad frames, but the same control sits at different heights on each (Moon School's Up Next card: y≈0.34 on iPhone, ≈0.20 on iPad). Use `hero` or `tilt` when the point moves between devices.
- 2026-11-11: Azan is a web clock in an Android WebView, so its captures came from Playwright, with two traps. First, a 1080×1920 phone shot (ratio 1.78) is silently dropped as "not a phone": phone captures must be taller than 1.8:1, e.g. 390×852 at 3×. Second, the Android status bar covers the top ~6% of the screen, and a web page has no band there, so the city name would be hidden. `azan/e2e/lobby-shots.spec.ts` stretches the page's top row into that band with ffmpeg; copy it for any web-built app. The icon must be ≥ 1024: render the app's SVG full-bleed (no corner radius, no alpha).
- 2026-11-11: 18-0 showed "inputs changed" because the owner moved its brand to Turf in `store/lobby.json` after the last build. When the captures haven't changed, rebuild and push; there's no need to recapture.
- 2026-11-11: The review watcher died on 2026-11-09 and nobody noticed for two days. launchd's login shell found `/usr/local/bin/node` (v16), which can't run the extensionless ES-module script (`ERR_UNKNOWN_FILE_EXTENSION`). install.sh now pins an absolute Node >= 22 in the plist. A dead watcher also stalls the Stage Manager agreement window, so check `~/.cache/lobby/review.log` when `/cue/api/agreement` stops counting.
