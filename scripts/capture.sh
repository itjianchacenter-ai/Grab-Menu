#!/bin/bash
# capture.sh — Login session + capture หลายสาขาใน 1 ครั้ง
#
# ใช้:  bash scripts/capture.sh <branch-id> [<branch-id> ...]
#
# ตัวอย่าง:
#   bash scripts/capture.sh 3-C4N3JLJHJTVGTJ
#   bash scripts/capture.sh 3-C6NBUAAUNACBNE 3-C6NBUAAVAGJDKE 3-C63FWBMXN2JUJJ

set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ $# -eq 0 ]; then
  echo "Usage: bash scripts/capture.sh <branch-id> [<branch-id> ...]"
  exit 1
fi

FIRST_ID="$1"

echo "🛑 ปิด Chrome เดิม..."
pkill -f "chrome-profiles/" 2>/dev/null || true
sleep 2

echo "🚀 เปิด Chrome (profile: $FIRST_ID)"
bash runner/launch-chrome.sh "$FIRST_ID" >/dev/null 2>&1 &
sleep 4

# Show credentials for the requested branches
node runner/vault.js >/dev/null 2>&1 # ensure dotenv loaded
cd runner
node -e "
const v = require('./vault');
const data = v.load();
const wanted = process.argv.slice(1);
const matches = data.branches.filter(b => wanted.includes(b.id));
console.log('═══════════════════════════════════════════════');
console.log('Login info:');
if (matches.length > 0) {
  console.log('  user: ' + matches[0].username);
  console.log('  pass: ' + matches[0].password);
  console.log('');
  console.log('สาขาที่จะ capture:');
  matches.forEach(b => console.log('  • ' + b.id + ' — ' + b.name.replace(/^.+? - /, '').slice(0, 50)));
}
console.log('═══════════════════════════════════════════════');
" -- "$@"
cd ..

echo ""
echo "👉 ใน Chrome ที่เปิด:"
echo "   1. Login ด้วย user/pass ข้างบน"
echo "   2. รอจนเห็นหน้าเมนู (URL มี $FIRST_ID)"
echo "   3. กลับมา Terminal นี้ กด Enter"
echo ""
read -p "พร้อม? Enter: " _

echo ""
SUCCESS=0
FAIL=0
for id in "$@"; do
  echo "──────────────────────────────────────"
  echo "📥 Capturing $id..."
  if (cd runner && node chrome-cdp-runner.js "$id"); then
    SUCCESS=$((SUCCESS+1))
  else
    FAIL=$((FAIL+1))
  fi
  sleep 2
done

echo ""
echo "═══════════════════════════════════════════════"
echo "✓ Synced: $SUCCESS · ✗ Failed: $FAIL"
echo ""
echo "Server state:"
curl -s http://localhost:8765/api/data 2>/dev/null | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    ms = d.get('merchants', {})
    print(f'  Total: {len(ms)} branches')
except: pass
"
