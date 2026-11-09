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
