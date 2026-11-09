#!/bin/zsh
# Install / refresh the Lobby agent: copy the engine to ~/.local/share/lobby (launchd can't read ~/Desktop
# without Full Disk Access; same reason as the agent-fleet kit) and load com.lobby.agent (daily 07:20).
# Idempotent. `./install.sh --uninstall` removes the job.
set -e
SRC=$(cd "$(dirname $0)" && pwd)
DST=$HOME/.local/share/lobby
PLIST=$HOME/Library/LaunchAgents/com.lobby.agent.plist
if [[ ${1:-} == --uninstall ]]; then launchctl bootout gui/$(id -u) $PLIST 2>/dev/null || true; launchctl bootout gui/$(id -u) $HOME/Library/LaunchAgents/com.lobby.review.plist 2>/dev/null || true; rm -f $PLIST $HOME/Library/LaunchAgents/com.lobby.review.plist; echo "removed com.lobby.agent and com.lobby.review"; exit; fi
mkdir -p $DST $HOME/.cache/lobby
rsync -a --delete --exclude .git --exclude node_modules --exclude SELF_CANCEL $SRC/ $DST/
[[ -f $DST/SELF_CANCEL ]] || date -v+60d +%Y%m%d > $DST/SELF_CANCEL
cat > $PLIST <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.lobby.agent</string>
  <key>ProgramArguments</key><array><string>/bin/zsh</string><string>-l</string><string>$DST/bin/lobby-cron</string></array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>20</integer></dict>
  <key>StandardOutPath</key><string>$HOME/.cache/lobby/launchd.log</string>
  <key>StandardErrorPath</key><string>$HOME/.cache/lobby/launchd.log</string>
</dict></plist>
EOF
# Reloading the job kills a run in progress (the first agent run died this way, 2026-11-04), so leave a running job
# alone: the engine files are already refreshed above, and the plist itself rarely changes.
if launchctl print gui/$(id -u)/com.lobby.agent 2>/dev/null | grep -q "state = running"; then
  echo "agent run in progress: engine refreshed, job not reloaded"; exit
fi
launchctl bootout gui/$(id -u) $PLIST 2>/dev/null || true
launchctl bootstrap gui/$(id -u) $PLIST
# Hourly App Store review watcher (bin/lobby-review-watch): no model, publishes changes to Cue.
RPLIST=$HOME/Library/LaunchAgents/com.lobby.review.plist
cat > $RPLIST <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.lobby.review</string>
  <key>ProgramArguments</key><array><string>/bin/zsh</string><string>-l</string><string>-c</string><string>cd \$HOME/Desktop/projects 2>/dev/null; node $DST/bin/lobby-review-watch</string></array>
  <key>StartInterval</key><integer>3600</integer>
  <key>StandardOutPath</key><string>$HOME/.cache/lobby/review.log</string>
  <key>StandardErrorPath</key><string>$HOME/.cache/lobby/review.log</string>
</dict></plist>
EOF
launchctl bootout gui/$(id -u) $RPLIST 2>/dev/null || true
launchctl bootstrap gui/$(id -u) $RPLIST
echo "com.lobby.review loaded: hourly, publishes App Store review changes to Cue"
echo "com.lobby.agent loaded: daily 07:20, engine at $DST, expires $(cat $DST/SELF_CANCEL)"
