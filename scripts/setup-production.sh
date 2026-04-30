#!/bin/bash
# Production setup for Mac — prevent sleep, install dashboard auto-start, install sync schedule
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DASHBOARD_PLIST="$HOME/Library/LaunchAgents/com.jiancha.dashboard.plist"
SYNC_PLIST_SRC="$ROOT/scripts/com.jiancha.grab-sync.plist"
SYNC_PLIST_DST="$HOME/Library/LaunchAgents/com.jiancha.grab-sync.plist"

echo "═══ JIANCHA Dashboard Production Setup ═══"
echo ""
echo "This will:"
echo "  1. Prevent Mac from sleeping (display can sleep)"
echo "  2. Install dashboard server as auto-starting service"
echo "  3. Install sync schedule (every 6h)"
echo ""
read -p "Continue? (y/N) " -n 1 -r
echo
[[ ! $REPLY =~ ^[Yy]$ ]] && exit 1

# ─── 1. Mac sleep settings ─────────────────────────────────────
echo ""
echo "[1/3] Configuring power settings (requires sudo)..."
sudo pmset -a sleep 0 displaysleep 10 disksleep 0 powernap 1 womp 1
echo "  ✓ Mac will not sleep (display sleeps after 10 min)"
echo "  ✓ Wake-on-LAN enabled"

# ─── 2. Dashboard auto-start ───────────────────────────────────
echo ""
echo "[2/3] Installing dashboard auto-start..."
mkdir -p "$ROOT/logs"

cat > "$DASHBOARD_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.jiancha.dashboard</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/python3</string>
        <string>$ROOT/server.py</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$ROOT</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>$ROOT/logs/dashboard.out.log</string>
    <key>StandardErrorPath</key>
    <string>$ROOT/logs/dashboard.err.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOST</key>
        <string>127.0.0.1</string>
        <key>PORT</key>
        <string>8765</string>
    </dict>
</dict>
</plist>
EOF

launchctl unload "$DASHBOARD_PLIST" 2>/dev/null || true
launchctl load "$DASHBOARD_PLIST"
echo "  ✓ Dashboard server installed → auto-starts on boot"

# ─── 3. Sync schedule ──────────────────────────────────────────
echo ""
echo "[3/3] Installing sync schedule..."
launchctl unload "$SYNC_PLIST_DST" 2>/dev/null || true
cp "$SYNC_PLIST_SRC" "$SYNC_PLIST_DST"
launchctl load "$SYNC_PLIST_DST"
echo "  ✓ Sync runs every 6h (with jitter + shuffle)"

# ─── Done ──────────────────────────────────────────────────────
echo ""
echo "═══ ✓ Production setup complete ═══"
echo ""
echo "Verify:"
echo "  pmset -g                                 # power settings"
echo "  launchctl list | grep jiancha            # services"
echo "  curl http://localhost:8765/api/health    # server up"
echo ""
echo "Logs:"
echo "  tail -f $ROOT/logs/dashboard.err.log"
echo "  tail -f $ROOT/runner/logs/launchd.log"
echo ""
echo "Manage:"
echo "  launchctl kickstart -k gui/\$(id -u)/com.jiancha.dashboard   # restart server"
echo "  launchctl start com.jiancha.grab-sync                       # force sync now"
echo "  launchctl unload $DASHBOARD_PLIST                           # uninstall server"
