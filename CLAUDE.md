# Lobby: working notes

Read README.md first. The agent brief is `prompts/agent.md`; the rules there bind any session working here.

## Environment nuances

| Nuance | What to do |
|---|---|
| Headless Chrome often exits non-zero ("Teardown watchdog expired") *after* writing the screenshot | `chrome()` in src/compose.mjs treats the PNG on disk (and its exact size) as success. |
| Parallel headless Chromes sharing one profile crash ("Trying to load the allocator multiple times") | Every render gets its own `--user-data-dir` temp profile. |
| Android status-bar sampling needs canvas `getImageData` on the capture | Captures are inlined as data: URIs, so the canvas is never tainted by file://. |
| `zoompan` emits `d` frames *per input frame* | Previews feed each still once (no `-loop`); with `-loop` an 8-shot preview ran 30.4 s and failed Apple's 30 s limit. |
| App Store display types: there's no `APP_IPHONE_69` | 6.9" (1320×2868) goes in `APP_IPHONE_67`; previews use `IPHONE_67` / `IPAD_PRO_3GEN_129`. |
| Screenshots can't change on a version that's Waiting for Review / live | `pushASC` checks `EDITABLE` and stages; status flags the app once a version opens. |
| Running from launchd | install.sh copies the engine to `~/.local/share/lobby`. The cron cds into ~/Desktop/projects for the app repos. Re-run `./install.sh` after changing the engine. |
| xcode-select points at CommandLineTools on this Mac | `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` for every simctl/xcodebuild call (the cron exports it). |
| The 17-0 repo forbids club names, marks and colours | Its `avoid` list carries the league and broadcaster names; frames name cities, never clubs. |

## Changing the look

Layouts live in `portrait()` / `landscape()` / `reel()` in src/compose.mjs. Every size is a fraction of
W/H so one layout serves every target. After a change, rebuild all three reference apps (moon-club: dark +
kids, 18-0: dark sports, hearth-app: light retro) and look at each `sheet.png` before committing.
