# Production Deployment Guide

## ✅ Fixed in code (ทำเสร็จแล้ว)

| ปัญหา | วิธีแก้ | ไฟล์ |
|---|---|---|
| Sync scripts ชนกัน | Lock file + PID check + stale detection | `runner/multi-account-sync.js` |
| empty-menu vs real fail | Detect "เริ่มต้นโดยเพิ่มช่วงเวลา" → kind:"empty" | `runner/multi-account-sync.js` |
| Schedule ใช้ auto-sync เก่า | เปลี่ยนเป็น `multi-account-sync.js --skip-fresh-hours 5 --jitter --shuffle` | `scripts/com.jiancha.grab-sync.plist` |
| Brute-force login | Rate limit 5 fails / 15 min / IP → 429 | `server.py` |
| Server restart kick session | Persist `.sessions.json` (chmod 600) | `server.py` |
| JSON file corruption | Atomic write (temp + fsync + rename) | `server.py` |
| ไม่มี monitoring | `GET /api/health` | `server.py` |
| CORS `*` อันตราย | restrict ตาม `CORS_ORIGINS` env | `server.py` |
| Single-thread server | `ThreadingHTTPServer` | `server.py` |
| Race conditions | `RLock` (DATA_LOCK + SESSIONS_LOCK) | `server.py` |
| Grab anti-bot — login ติดกัน | Jitter (60-300s random) + shuffle order | `runner/multi-account-sync.js` |
| Grab anti-bot — fail ติดกัน | Circuit breaker (3 consecutive fails → stop) | `runner/multi-account-sync.js` |
| Grab anti-bot — ทุก 3h ถี่ไป | ลด → ทุก 6h | `scripts/com.jiancha.grab-sync.plist` |
| Cookie ไม่ secure ผ่าน HTTPS | `SECURE_COOKIE=true` env flag | `server.py` |

---

## 🛡️ Strategy แทน Grab Partner API (ฟรี ไม่ต้องเสียค่า API)

### หลักการ: ลด footprint ให้ดูเหมือนการใช้งานปกติ

| มาตรการ | สถานะ | คำอธิบาย |
|---|---|---|
| 🔄 Frequency 3h → **6h** | ✅ ทำแล้ว | ลด login load 50% |
| 🎲 Jitter 60-300 วินาที | ✅ ทำแล้ว | random delay กัน pattern recognition |
| 🔀 Shuffle account order | ✅ ทำแล้ว | ไม่ login เรียงเดิมทุกครั้ง |
| 🛑 Circuit breaker | ✅ ทำแล้ว | หยุดถ้า fail 3 ติด → กัน account ban |
| ⏰ Skip fresh-hours 5 | ✅ ทำแล้ว | ไม่ดึงซ้ำถ้าเพิ่งดึงไป |
| 📋 Persistent profiles | 🟡 Future | เก็บ session ไว้ ไม่ login บ่อย |
| 🌐 Stealth plugin | 🟡 Future | ซ่อน `navigator.webdriver` |
| 🔌 Proxy rotation | 🟡 Future | ใช้ residential IP TH หลายตัว |
| 👤 Browser fingerprint | 🟡 Future | random viewport / UA / fonts |

### 🔍 ติดตามความเสี่ยง
```bash
# ดู login fail rate
grep "login failed" runner/logs/multi-account-*.log | wc -l

# ถ้า fail > 5/วัน → หยุด schedule + login manual + reset
launchctl unload ~/Library/LaunchAgents/com.jiancha.grab-sync.plist
```

---

## 🆓 HTTPS ฟรี — Cloudflare Tunnel (แทน VPS + nginx)

ไม่ต้องเช่า VPS ไม่ต้อง config nginx ไม่ต้องซื้อ SSL — ฟรีทั้งหมด

### Setup (15 นาที)
```bash
# 1. ติดตั้ง cloudflared บน Mac
brew install cloudflared

# 2. Login เข้า Cloudflare (ต้องมีโดเมน — ถ้าไม่มีซื้อจาก Namecheap ~300 บาท/ปี)
cloudflared tunnel login

# 3. สร้าง tunnel
cloudflared tunnel create jiancha-dashboard

# 4. Map subdomain → localhost:8765
cloudflared tunnel route dns jiancha-dashboard dashboard.yourdomain.com

# 5. Config ~/.cloudflared/config.yml:
#   tunnel: <tunnel-id>
#   credentials-file: ~/.cloudflared/<tunnel-id>.json
#   ingress:
#     - hostname: dashboard.yourdomain.com
#       service: http://localhost:8765
#     - service: http_status:404

# 6. รันเป็น service (auto-start)
sudo cloudflared service install

# 7. ตั้ง env บน server.py
echo "CORS_ORIGINS=https://dashboard.yourdomain.com" >> .env
echo "SECURE_COOKIE=true" >> .env
```

**ข้อดี:**
- ✅ HTTPS อัตโนมัติ (Cloudflare SSL)
- ✅ DDoS protection ฟรี
- ✅ ไม่ต้องเปิด port บน firewall บ้าน
- ✅ ใช้ได้แม้อยู่หลัง NAT
- ✅ ฟรี (Free tier 50 users/tunnel)

**ข้อจำกัด:**
- ต้องมีโดเมน (Cloudflare ไม่ทำ DNS เปล่า)
- Mac ต้องเปิดอยู่ (อ่านส่วนถัดไป)

---

## 🖥️ ใช้ Mac เป็น 24/7 Server (แทน VPS)

ไม่ต้องเช่า VPS — ใช้ Mac ปัจจุบันให้รันตลอด

### 1. กัน Mac sleep
```bash
# วิธี A: Caffeinate ตอน server รัน
caffeinate -d -i -s python3 server.py

# วิธี B: เปลี่ยนใน System Settings (ถาวร)
sudo pmset -a sleep 0      # never sleep
sudo pmset -a displaysleep 10  # display ปิด 10 นาที
sudo pmset -a disksleep 0  # disk ไม่ sleep
sudo pmset -a powernap 1   # ทำงานช่วง low-power
```

### 2. Auto-start server เมื่อเปิดเครื่อง
```bash
# สร้าง launchd plist
cat > ~/Library/LaunchAgents/com.jiancha.dashboard.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.jiancha.dashboard</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/python3</string>
        <string>/Users/guest1123/Grab - Menu/server.py</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/guest1123/Grab - Menu</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/guest1123/Grab - Menu/logs/dashboard.out.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/guest1123/Grab - Menu/logs/dashboard.err.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOST</key>
        <string>0.0.0.0</string>
        <key>CORS_ORIGINS</key>
        <string>https://dashboard.yourdomain.com</string>
        <key>SECURE_COOKIE</key>
        <string>true</string>
    </dict>
</dict>
</plist>
EOF

launchctl load ~/Library/LaunchAgents/com.jiancha.dashboard.plist
launchctl start com.jiancha.dashboard
```

### 3. UPS เพื่อกันไฟดับ
- APC Back-UPS 500VA ~2,500 บาท
- ป้องกัน data corruption + downtime ตอนไฟดับชั่วคราว

### 4. Monitoring แบบฟรี
**healthchecks.io** (ฟรี 20 checks)
```bash
# ทุก 5 นาทีเช็ค health → ถ้าไม่ตอบใน 10 นาที จะส่ง email/Slack alert
*/5 * * * * curl -fsS http://localhost:8765/api/health > /dev/null && curl -fsS https://hc-ping.com/<your-uuid>
```

---

## 🆓 ทางเลือกอื่น (ทั้งหมดฟรี)

### Tailscale (private network)
ถ้าต้องการให้ทีมเข้าถึงโดยไม่เปิด public:
```bash
brew install --cask tailscale
tailscale up
tailscale serve https / http://localhost:8765
# Access: https://your-mac-name.your-tailnet.ts.net
```

### ngrok (test/demo)
```bash
brew install ngrok
ngrok http 8765
# ได้ URL ชั่วคราว ใช้ test รวดเร็ว
```

### Free domain
- **DuckDNS:** subdomain ฟรีตลอดชีพ (jiancha.duckdns.org)
- **Freenom:** .tk/.ml/.ga ฟรี 1 ปี
- **No-IP:** dynamic DNS ฟรี

---

## 📊 ข้อเปรียบเทียบสรุป

| | ของเดิม | Cloudflare Tunnel | VPS Linux |
|---|---|---|---|
| ค่าใช้จ่าย/เดือน | 0 | 0 (+โดเมน 25/เดือน) | 200-500 |
| HTTPS | ❌ | ✅ ฟรี | ⚠️ setup เอง |
| Public access | ❌ localhost only | ✅ | ✅ |
| Setup time | done | 15 นาที | 2-3 วัน |
| Maintenance | low | low | medium |
| ต้องเปิด Mac | ✅ | ✅ | ❌ |
| Grab geo-block (TH) | ✅ ผ่าน | ✅ ผ่าน | ❌ ต้องใช้ TH proxy |

**แนะนำ:** ใช้ Mac + Cloudflare Tunnel = ฟรี + ครบทุกอย่างที่ต้องการ

---

## 🔐 Compliance / Legal

> การ scrape merchant portal โดยไม่ได้รับอนุญาตอาจขัด ToS ของ Grab
> มาตรการลดความเสี่ยงข้างต้นช่วยลดโอกาสโดน detect แต่ไม่ขจัดความเสี่ยงทางกฎหมาย

**เพิ่มเติมที่ทำได้:**
- จำกัดให้ใช้ภายในบริษัทเท่านั้น (ไม่ public)
- ไม่ใช้ data scraped ไปแข่งขันกับ Grab โดยตรง
- ขอความเห็นชอบจาก Grab account manager (informal)

---

## 📋 Production checklist (ฟรี-only path)

- [ ] ซื้อโดเมน ~300 บาท/ปี (Namecheap/Cloudflare Registrar)
- [ ] ติดตั้ง Cloudflare Tunnel (`brew install cloudflared`)
- [ ] สร้าง tunnel + map subdomain
- [ ] เซ็ต `SECURE_COOKIE=true` + `CORS_ORIGINS=https://dashboard.yourdomain.com`
- [ ] เซ็ต `HOST=127.0.0.1` (Cloudflare reaches via tunnel)
- [ ] กัน Mac sleep + setup auto-start launchd
- [ ] ติด UPS (~2,500 บาท)
- [ ] ตั้ง healthchecks.io alert
- [ ] เปลี่ยน password ใน `users.json` ให้แข็งแรง
- [ ] Backup `vault.enc` + `users.json` ใส่ encrypted ขึ้น cloud (rclone + S3 free tier)

**ค่าใช้จ่ายรวม: ~300 บาท/ปี (โดเมน) + 2,500 บาท (UPS, ครั้งเดียว)**

---

## 🔧 Operations

```bash
# Health check
curl https://dashboard.yourdomain.com/api/health

# Force sync now
launchctl start com.jiancha.grab-sync

# Manual sync with full safety
cd runner
JITTER_MIN=60 JITTER_MAX=300 node multi-account-sync.js --jitter --shuffle

# Test 1 account only
node multi-account-sync.js --account jiancha.mkt.fc1

# View pending branches
node branch-list.js

# Check tunnel status
cloudflared tunnel info jiancha-dashboard

# Server restart (auto via launchd)
launchctl kickstart -k gui/$(id -u)/com.jiancha.dashboard
```
