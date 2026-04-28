# runner — Playwright Orchestrator

ดึงข้อมูลเมนูจากทุกสาขา Grab Merchant อัตโนมัติ โดยใช้ Chrome จริง + extension เดิม

## โครงสร้าง

| ไฟล์ | หน้าที่ |
|---|---|
| [vault.js](vault.js) | encrypt/decrypt vault (AES-256-GCM + PBKDF2) |
| [vault-cli.js](vault-cli.js) | CLI จัดการ credentials |
| [login.js](login.js) | login flow (selectors แบบ generic) |
| [index.js](index.js) | main orchestrator — loop ทุกสาขา |
| `.env` | `VAULT_PASSWORD`, delays, retries (ห้าม commit) |
| `vault.enc` | encrypted credentials (อยู่ที่ `../vault.enc`) |
| `profiles/<id>/` | persistent Chrome profile ต่อสาขา (cookies เก็บ) |
| `logs/runner-YYYY-MM-DD.log` | log ทุกการรัน |

## Setup ครั้งแรก

```bash
# 1) ตั้ง master password
cd runner
cp .env.example .env
# แก้ไฟล์ .env ใส่ VAULT_PASSWORD เป็น string ยาวๆ (อย่างน้อย 20 ตัว)

# 2) สร้าง vault
node vault-cli.js init

# 3) เพิ่มสาขา
node vault-cli.js add 3-C6LELZAYNNVHGA "JIANCHA TEA - บรรทัดทอง"
# จะถาม username / password — พิมพ์ใส่

# หรือ bulk import จาก JSON (ลบไฟล์ plaintext หลัง import!)
node vault-cli.js import branches.json

# 4) ตรวจรายการ
node vault-cli.js list
```

## รัน

```bash
# ลองสาขาเดียวก่อน (กำหนดใน .env: BRANCHES_LIMIT=1 หรือ)
BRANCHES_LIMIT=1 node index.js

# รันทุกสาขา
node index.js
```

ตอนรัน:
- เปิด Chrome (real, headed) ของ Playwright
- โหลด extension จาก `../extension`
- โหลด profile ของสาขานั้น (ครั้งแรก = ว่าง, จะ login + เก็บ cookie)
- ไป `merchant.grab.com/food/menu/<id>/menuOverview`
- รอ 12 วินาทีให้ extension จับเมนู
- POST ไป `localhost:8765/api/sync`
- ปิด browser → sleep 20-60 วินาที → สาขาถัดไป

## Flow

```
[vault.enc]  ──decrypt──>  [credentials in memory]
                                  ↓
                     ┌─────────────────────┐
                     │ for each branch:    │
                     │   1. open Chrome    │
                     │   2. load profile   │
                     │   3. navigate menu  │
                     │   4. login if need  │
                     │   5. wait 12s       │
                     │   6. verify /api/data│
                     │   7. close          │
                     │   8. sleep 20-60s   │
                     └─────────────────────┘
                                  ↓
                  [server-data.json + dashboard]
```

## Schedule (macOS launchd)

ดูตัวอย่างใน `scripts/install-launchd.sh` (TBD)

## Troubleshooting

**`VAULT_PASSWORD env not set`**
- แก้ `.env` ใส่ค่าให้ `VAULT_PASSWORD`

**`login form: email field not found`**
- Grab อาจเปลี่ยน DOM — แก้ selectors ใน [login.js](login.js)
- ลอง `HEADLESS=false node index.js` เพื่อดูหน้าตรงๆ

**Extension ไม่ดักข้อมูล**
- ตรวจ `console.log` ของ Chrome (ใน Playwright เปิด DevTools manual)
- เปิด `DEBUG=true node index.js` → log message จากหน้า

**Profile หาย / login บ่อย**
- Cookie อาจหมดอายุ → runner จะ auto-login ใหม่
- ห้ามลบ `runner/profiles/` ระหว่างรัน

## Security

- `vault.enc` = AES-256-GCM, master password 600k PBKDF2 iterations
- ไม่ commit: `.env`, `vault.enc`, `profiles/` (อยู่ใน `.gitignore`)
- หลัง bulk import → ลบไฟล์ JSON plaintext ทันที
- VPS deploy → ใส่ `VAULT_PASSWORD` ใน systemd EnvironmentFile (mode 0600)
