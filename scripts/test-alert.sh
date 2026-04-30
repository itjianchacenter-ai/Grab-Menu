#!/bin/bash
# Send a test alert to verify webhook (Slack / Discord / Teams)
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="$ROOT/scripts/watchdog.env"

if [ ! -f "$CONFIG" ]; then
  echo "✗ Config file not found: $CONFIG"
  echo "  Run: cp scripts/watchdog.env.example scripts/watchdog.env"
  echo "  Then edit and add your ALERT_WEBHOOK + ALERT_FORMAT"
  exit 1
fi

set -a; . "$CONFIG"; set +a

if [ -z "$ALERT_WEBHOOK" ]; then
  echo "✗ ALERT_WEBHOOK not set in $CONFIG"
  exit 1
fi

ALERT_FORMAT="${ALERT_FORMAT:-slack}"
NOW=$(date '+%Y-%m-%d %H:%M:%S')
MSG="✅ Test alert from JIANCHA Dashboard at $NOW"

echo "Sending test alert (format: $ALERT_FORMAT)..."

case "$ALERT_FORMAT" in
  teams)
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
          {"type":"TextBlock","text":"✅ JIANCHA Dashboard — Test","weight":"Bolder","size":"Medium","color":"Good"},
          {"type":"TextBlock","text":"Webhook test successful","wrap":true},
          {"type":"TextBlock","text":"$NOW","size":"Small","isSubtle":true}
        ]
      }
    }
  ]
}
EOF
)
    ;;
  discord)
    body="{\"content\":\"$MSG\"}"
    ;;
  *)
    body="{\"text\":\"$MSG\"}"
    ;;
esac

http=$(curl -s -o /tmp/alert-resp.txt -w "%{http_code}" -X POST -H "Content-Type: application/json" -d "$body" "$ALERT_WEBHOOK")

if [ "$http" = "200" ] || [ "$http" = "202" ] || [ "$http" = "204" ]; then
  echo "✓ Alert sent (HTTP $http) — check your $ALERT_FORMAT channel"
else
  echo "✗ Webhook returned HTTP $http"
  echo "Response:"
  cat /tmp/alert-resp.txt
  echo ""
fi
