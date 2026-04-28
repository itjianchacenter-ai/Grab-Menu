#!/bin/bash
# Restore encrypted backup
#
# ใช้: bash scripts/restore.sh backups/backup-<TIMESTAMP>.tar.gz.enc

set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

INPUT="$1"
if [ -z "$INPUT" ]; then
  echo "Usage: bash scripts/restore.sh <backup-file>"
  echo ""
  echo "Available backups:"
  ls -lh backups/*.tar.gz.enc 2>/dev/null || echo "  (none)"
  exit 1
fi

if [ ! -f "$INPUT" ]; then
  echo "❌ ไม่พบไฟล์: $INPUT"
  exit 1
fi

read -rsp "Backup passphrase: " PASS
echo

echo "🔓 กำลัง decrypt + extract..."
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass "pass:$PASS" -in "$INPUT" \
  | tar -xzv

echo ""
echo "✓ Restored from $INPUT"
echo ""
echo "ตรวจ:  cd runner && node vault-cli.js list"
