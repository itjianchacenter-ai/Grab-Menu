#!/bin/bash
# Install launchd schedule — auto-sync ทุก 3 ชั่วโมง

set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$ROOT/scripts/com.jiancha.grab-sync.plist"
INSTALL_PATH="$HOME/Library/LaunchAgents/com.jiancha.grab-sync.plist"

if [ ! -f "$PLIST" ]; then
  echo "❌ ไม่พบ $PLIST"
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"

# Unload old (if exists)
launchctl unload "$INSTALL_PATH" 2>/dev/null || true

# Copy + load
cp "$PLIST" "$INSTALL_PATH"
launchctl load "$INSTALL_PATH"

echo "✓ Schedule installed: $INSTALL_PATH"
echo ""
echo "ทำงาน:"
echo "  • รัน auto-sync.js ทุก 3 ชั่วโมง"
echo "  • Log: $ROOT/runner/logs/launchd.{out,err}.log"
echo ""
echo "คำสั่งจัดการ:"
echo "  launchctl list | grep grab-sync          # check status"
echo "  launchctl unload $INSTALL_PATH           # uninstall"
echo "  launchctl start com.jiancha.grab-sync    # run now"
