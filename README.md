# Grab Menu Checker

Chrome Extension สำหรับดู **เมนูบน Grab Food** ของร้านตัวเอง โดย**ไม่ต้องใช้ API ของ Grab**
ทำงานในเบราว์เซอร์ที่ login merchant.grab.com อยู่แล้ว → ดักข้อมูลที่ Grab ส่งกลับ → แสดงพร้อมประวัติการเปลี่ยนสถานะ

## Features

- 📋 รายการเมนูทุกหมวดหมู่
- 🖼️ รูปภาพเมนู
- 🟢/🔴 สถานะ ขายอยู่ / หมด
- 🕐 เวลาที่เมนูถูกเปิด-ปิดล่าสุด
- 📜 Log การเปลี่ยนแปลง (เปิด, ปิด, ราคา, เพิ่ม, ลบ)
- 🏪 รองรับหลายสาขา

## วิธีติดตั้ง (1 ครั้ง)

1. เปิด Chrome → ไปที่ `chrome://extensions`
2. เปิด **Developer mode** (มุมขวาบน)
3. คลิก **Load unpacked**
4. เลือกโฟลเดอร์ `extension/` ใน project นี้
5. ✅ เห็นไอคอน "Grab Menu Checker" บน toolbar

## วิธีใช้

1. เข้า [merchant.grab.com](https://merchant.grab.com/) → login → ไปที่หน้าเมนู
2. รอหน้าโหลด — extension จะดักข้อมูลอัตโนมัติ
3. คลิกไอคอน extension → เห็นเมนูทั้งหมด

ไปกี่ครั้ง = update กี่ครั้ง — log จะค่อยๆ สะสมเมื่อสถานะเปลี่ยน

## โครงสร้าง

```
extension/
├── manifest.json     ประกาศ permission + content script
├── content.js        bridge: page world ↔ chrome.storage
├── inject.js         รันใน page world, hook fetch/XHR
├── popup.html        UI
├── popup.css
├── popup.js          render เมนู + log จาก chrome.storage
└── icons/            16/48/128 px
```

## Privacy

- ข้อมูลทั้งหมดเก็บใน `chrome.storage.local` (เฉพาะเครื่องคุณ)
- **ไม่มี server**, ไม่มีการส่งข้อมูลออก
- Extension เข้าได้แค่ `merchant.grab.com` และ `*.grabtaxi.com` (ตาม manifest)

## Limit

- ความละเอียดของ log = ความถี่ที่คุณเข้าหน้าเมนู (เปิดครั้งเดียว = 1 snapshot)
- ถ้าไม่เปิดดูนานๆ จะไม่มี log ในช่วงนั้น
- ถ้า Grab เปลี่ยนโครงสร้าง response — parser อาจต้องปรับ
