#!/bin/bash
# Production watchdog — checks server health + alerts on issues
# Add to cron / launchd to run every 5-10 minutes
#
# ENV vars:
#   ALERT_WEBHOOK    Slack/Discord webhook URL (optional)
#   STALE_HOURS      Alert if last sync older than this (default 8)
#   CHROME_PORT      Chrome remote-debugging port (default 9222)

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Load config (Slack webhook, thresholds, etc.) — gitignored
CONFIG="$ROOT/scripts/watchdog.env"
if [ -f "$CONFIG" ]; then
  set -a; . "$CONFIG"; set +a
fi

URL="http://localhost:8765/api/health"
STALE_HOURS="${STALE_HOURS:-8}"
CHROME_PORT="${CHROME_PORT:-9222}"
ALERT_FORMAT="${ALERT_FORMAT:-slack}"
LOG="$ROOT/logs/watchdog.log"
mkdir -p "$(dirname "$LOG")"

ts() { date "+%Y-%m-%d %H:%M:%S"; }
log() { echo "[$(ts)] $*" | tee -a "$LOG"; }

alert() {
  local msg="$1"
  log "🚨 ALERT: $msg"
  [ -z "$ALERT_WEBHOOK" ] && return 0
  local body
  case "$ALERT_FORMAT" in
    teams)
      # Microsoft Teams (Workflows / Power Automate — Adaptive Card)
      body=$(cat <<EOF
{
  "type": "message",
  "attachments": [
    {
      "contentType": "application/vnd.microsoft.card.adaptive",
      "content": {
        "type": "AdaptiveCard",
        "\$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
        "version": "1.4",
        "body": [
          {"type":"TextBlock","text":"🚨 JIANCHA Dashboard","weight":"Bolder","size":"Medium","color":"Attention"},
          {"type":"TextBlock","text":"$(echo "$msg" | sed 's/"/\\"/g')","wrap":true},
          {"type":"TextBlock","text":"$(date '+%Y-%m-%d %H:%M:%S %Z')","size":"Small","isSubtle":true}
        ]
      }
    }
  ]
}
EOF
)
      ;;
    discord)
      body="{\"content\":\"🚨 JIANCHA Dashboard: $msg\"}"
      ;;
    *)
      body="{\"text\":\"🚨 JIANCHA Dashboard: $msg\"}"
      ;;
  esac
  curl -s -X POST -H "Content-Type: application/json" -d "$body" \
    "$ALERT_WEBHOOK" >/dev/null 2>&1 || true
}

# ─── Check 1: dashboard server up ────────────────────────────
if ! resp=$(curl -fsS "$URL" 2>&1); then
  alert "Dashboard server DOWN — $URL not responding"
  # Try to restart
  launchctl kickstart -k "gui/$(id -u)/com.jiancha.dashboard" 2>/dev/null && \
    log "  → attempted restart via launchctl" || \
    log "  → restart failed (manual intervention needed)"
  exit 1
fi
log "✓ Dashboard server up"

# ─── Check 2: data freshness ─────────────────────────────────
stale_min=$(echo "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('last_sync_minutes_ago') or 0)")
stale_max=$((STALE_HOURS * 60))
if [ "$stale_min" -gt "$stale_max" ]; then
  alert "Data stale — last sync ${stale_min}min ago (>${STALE_HOURS}h)"
fi
log "✓ Data freshness: ${stale_min}min ago"

# ─── Check 3: Chrome remote-debugging port ───────────────────
if ! curl -fsS "http://localhost:$CHROME_PORT/json/version" >/dev/null 2>&1; then
  alert "Chrome debug port $CHROME_PORT not responding — orchestrator will fail"
fi
log "✓ Chrome port $CHROME_PORT alive"

# ─── Check 4: paused accounts ────────────────────────────────
FAIL_FILE="$ROOT/runner/logs/.account-fails.json"
if [ -f "$FAIL_FILE" ]; then
  paused=$(python3 -c "
import json, time
try:
  d = json.load(open('$FAIL_FILE'))
  now = time.time() * 1000
  paused = [u for u, e in d.items() if e.get('pausedUntil', 0) > now]
  print(len(paused), '|', ','.join(paused))
except: print('0|')
")
  count="${paused%%|*}"
  list="${paused##*|}"
  if [ "$count" -gt 0 ]; then
    alert "$count accounts paused: $list"
  else
    log "✓ No paused accounts"
  fi
fi

# ─── Check 5: log file sizes ─────────────────────────────────
for f in "$ROOT/logs/dashboard.err.log" "$ROOT/runner/logs/launchd.log"; do
  [ -f "$f" ] || continue
  size_mb=$(du -m "$f" | cut -f1)
  if [ "$size_mb" -gt 100 ]; then
    log "⚠ Log $f is ${size_mb}MB — rotate recommended"
    # Rotate (keep last 10MB)
    tail -c 10M "$f" > "$f.tmp" && mv "$f.tmp" "$f"
    log "  → rotated $f"
  fi
done

log "═══ All checks passed ═══"
