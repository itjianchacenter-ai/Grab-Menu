#!/bin/bash
# Encrypted backup ของ sensitive files
# Output: backups/backup-<TIMESTAMP>.tar.gz.enc (ปลอดภัยสำหรับ push git)
#
# ใช้:  bash scripts/backup.sh
# แล้วใส่ passphrase ของ backup (ห้ามใช้ VAULT_PASSWORD)
#
# Restore:  bash scripts/restore.sh backups/backup-<TIMESTAMP>.tar.gz.enc

set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OUT="backups/backup-$(date +%Y%m%d-%H%M%S).tar.gz.enc"
mkdir -p backups

# Files to back up
FILES=()
[ -f vault.enc ]                && FILES+=(vault.enc)
[ -f runner/.env ]              && FILES+=(runner/.env)
[ -f server-data.json ]         && FILES+=(server-data.json)
[ -d runner/profiles ]          && FILES+=(runner/profiles)
[ -d runner/chrome-profiles ]   && FILES+=(runner/chrome-profiles)

if [ ${#FILES[@]} -eq 0 ]; then
  echo "❌ ไม่มีไฟล์ให้ backup"
  exit 1
fi

echo "ไฟล์ที่จะ backup:"
for f in "${FILES[@]}"; do
  size=$(du -sh "$f" 2>/dev/null | cut -f1)
  echo "  • $f  ($size)"
done
echo ""

# Get passphrase
read -rsp "Backup passphrase (≥12 chars, ต่างจาก VAULT_PASSWORD): " PASS
echo
if [ ${#PASS} -lt 12 ]; then
  echo "❌ Passphrase สั้นไป (ต้อง ≥12)"
  exit 1
fi
read -rsp "ยืนยัน passphrase อีกครั้ง: " PASS2
echo
if [ "$PASS" != "$PASS2" ]; then
  echo "❌ Passphrase ไม่ตรงกัน"
  exit 1
fi

# Create encrypted tar
echo "🔐 กำลัง encrypt..."
tar -cz "${FILES[@]}" 2>/dev/null \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass "pass:$PASS" \
  > "$OUT"

SIZE=$(du -h "$OUT" | cut -f1)
echo ""
echo "✓ Backup: $OUT  ($SIZE)"
echo ""
echo "ขั้นต่อไป:"
echo "  1. เก็บ passphrase ใน password manager (1Password / Notes)"
echo "  2. Push ขึ้น git:"
echo "       git add -f $OUT"
echo "       git commit -m 'Backup $(date +%Y-%m-%d)'"
echo "       git push"
echo ""
echo "Restore:  bash scripts/restore.sh $OUT"
