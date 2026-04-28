#!/bin/bash
# launch-chrome.sh — เริ่ม Chrome ที่ใช้งานได้กับ chrome-cdp-runner
#
# - เปิด Chrome แยกต่างหากจาก Chrome ปกติของคุณ (มี user-data-dir ต่างหาก)
# - โหลด extension เดิมจาก ../extension
# - เปิด debug port 9222 ให้ script เชื่อมต่อ
#
# ใช้: bash launch-chrome.sh [profile-name]
#   profile-name: ชื่อ profile ใต้ runner/chrome-profiles/  (default: shared)

PROFILE="${1:-shared}"
PROFILES_ROOT="$(cd "$(dirname "$0")" && pwd)/chrome-profiles"
EXT_REAL_PATH="$(cd "$(dirname "$0")/../extension" && pwd)"
USER_DATA_DIR="$PROFILES_ROOT/$PROFILE"
PORT="${PORT:-9222}"

# Chrome --load-extension breaks on paths with spaces.
# Create a symlink without spaces and use that.
EXT_LINK="$HOME/.grab-menu-extension"
if [ ! -L "$EXT_LINK" ] || [ "$(readlink "$EXT_LINK")" != "$EXT_REAL_PATH" ]; then
  rm -f "$EXT_LINK"
  ln -s "$EXT_REAL_PATH" "$EXT_LINK"
fi
EXT_PATH="$EXT_LINK"

mkdir -p "$USER_DATA_DIR"

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [ ! -x "$CHROME" ]; then
  echo "❌ Google Chrome not found at $CHROME"
  exit 1
fi

# Kill any existing Chrome instance using the same user data dir
# (avoid duplicate-instance errors)
pkill -f "user-data-dir=$USER_DATA_DIR" 2>/dev/null
sleep 1

echo "🚀 Launching Chrome"
echo "   profile : $PROFILE"
echo "   data    : $USER_DATA_DIR"
echo "   ext     : $EXT_PATH"
echo "   debug   : http://localhost:$PORT"
echo ""

"$CHROME" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$USER_DATA_DIR" \
  --load-extension="$EXT_PATH" \
  --no-first-run \
  --no-default-browser-check \
  --disable-features=Translate \
  "https://merchant.grab.com/portal" \
  &

CHROME_PID=$!
echo "✓ Chrome started (PID $CHROME_PID)"
echo ""
echo "ขั้นต่อไป:"
echo "  1. Login ใน Chrome ที่เปิดมา"
echo "  2. รัน:  node chrome-cdp-runner.js [branch-id]"
echo ""
echo "(Chrome จะรันต่อในพื้นหลัง — ปิดได้ด้วย Cmd+Q ใน Chrome หรือ:"
echo "  pkill -f 'user-data-dir=$USER_DATA_DIR')"
