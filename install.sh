#!/bin/zsh
# Install / refresh the Lobby agent: copy the engine to ~/.local/share/lobby (launchd can't read ~/Desktop
# without Full Disk Access; same reason as the agent-fleet kit) and load com.lobby.agent (daily 07:20).
# Idempotent. `./install.sh --uninstall` removes the job.
set -e
SRC=$(cd "$(dirname $0)" && pwd)
DST=$HOME/.local/share/lobby
PLIST=$HOME/Library/LaunchAgents/com.lobby.agent.plist
if [[ ${1:-} == --uninstall ]]; then launchctl bootout gui/$(id -u) $PLIST 2>/dev/null || true; rm -f $PLIST; echo "removed com.lobby.agent"; exit; fi
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
launchctl bootout gui/$(id -u) $PLIST 2>/dev/null || true
launchctl bootstrap gui/$(id -u) $PLIST
echo "com.lobby.agent loaded: daily 07:20, engine at $DST, expires $(cat $DST/SELF_CANCEL)"
