#!/bin/bash
# Deploy: commit staged files → push GitHub → pull on DigitalOcean → verify
#
# Usage:
#   git add <files>
#   bash scripts/deploy.sh "commit message"
#
# Or all-in-one with -a (stages all tracked changes — careful with secrets):
#   bash scripts/deploy.sh -a "commit message"

set -e

DO_HOST="root@152.42.189.19"
DO_PATH="/root/Grab-Menu"
HEALTH_URL="https://grab.jc-group-global.com/api/health"

# Parse args
if [ "$1" = "-a" ]; then
  STAGE_ALL=1
  shift
fi
MSG="$1"

if [ -z "$MSG" ]; then
  echo "Usage: bash scripts/deploy.sh [-a] \"commit message\""
  echo ""
  echo "  Without -a: stages nothing, expects you to git add manually first"
  echo "  With -a   : stages all tracked changes (faster, riskier)"
  exit 1
fi

cd "$(git rev-parse --show-toplevel)"

if [ "$STAGE_ALL" = "1" ]; then
  git add -u
fi

if git diff --staged --quiet; then
  echo "✗ Nothing staged. Run: git add <files>  (or use -a)"
  exit 1
fi

echo "═══ 1/4  Commit ═══"
git commit -m "$(cat <<EOF
$MSG

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"

echo ""
echo "═══ 2/4  Push GitHub ═══"
git push origin main 2>&1 | tail -3

echo ""
echo "═══ 3/4  Pull on DigitalOcean ═══"
ssh -o BatchMode=yes -o ConnectTimeout=10 "$DO_HOST" "cd $DO_PATH && git pull origin main" 2>&1 | tail -5

echo ""
echo "═══ 4/4  Health check ═══"
sleep 1
HEALTH=$(curl -fsS "$HEALTH_URL" 2>&1 || echo "FAIL")
if echo "$HEALTH" | grep -q '"ok": true'; then
  MERCHANTS=$(echo "$HEALTH" | python3 -c "import json,sys;print(json.load(sys.stdin)['merchants'])" 2>/dev/null)
  echo "✓ Live: $HEALTH_URL ($MERCHANTS merchants)"
else
  echo "⚠ Health check failed: $HEALTH"
fi

echo ""
echo "✓ Deployed — refresh https://grab.jc-group-global.com (⌘+Shift+R)"
