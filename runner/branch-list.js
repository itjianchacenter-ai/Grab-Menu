#!/usr/bin/env node
"use strict";
require("dotenv").config({ path: require("path").resolve(__dirname, ".env") });
const { load } = require("./vault");
const fs = require("fs");
const path = require("path");

const MASTER_IDS = new Set([
  "3-C6LELZAYNNVHGA", "3-C72TAKABAKE1V2", "3-C4N3JLJHJTVGTJ",
  "3-C62EJCKTEYJCCA", "3-C7CDRBXCC2T1NJ", "3-C7KGRRBBNPLGPE",
  "3-C6U1BACJN321NN", "3-C7K3EFBCPGB3VN",
]);

const NOT_AVAILABLE_REASONS = {
  "3-C6LELZAYKAL1RN": "ปิดถาวร [CLOSE UP]",
  "3-C7VYEBKERVCXTA": "ยังไม่มีเมนูใน Grab",
  "3-C7NCUA3UGFXXV6": "ยังไม่มีเมนูใน Grab",
  "3-C7TECY2ZL2TEHE": "ยังไม่มีเมนูใน Grab",
};

(async () => {
  const v = await load();
  const vault = v.entries || v.branches || [];
  const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../server-data.json"), "utf8"));

  const all = [];
  for (const e of vault) {
    const m = data.merchants[e.id];
    all.push({
      id: e.id, name: e.name,
      captured: !!m,
      itemCount: m?.items?.length || 0,
      isMaster: MASTER_IDS.has(e.id),
      reason: NOT_AVAILABLE_REASONS[e.id] || (m ? null : "ยังไม่ capture"),
    });
  }
  const vaultIds = new Set(vault.map((e) => e.id));
  for (const [mid, m] of Object.entries(data.merchants)) {
    if (vaultIds.has(mid)) continue;
    all.push({
      id: mid, name: m.name, captured: true,
      itemCount: m.items?.length || 0,
      isMaster: MASTER_IDS.has(mid), reason: null,
    });
  }

  const clean = (s) =>
    (s || "?")
      .replace(/Jian cha Tea 见茶山\(เจี้ยนชา\) -\s*/g, "")
      .replace(/JIANCHA TEA \(เจี้ยนชา\) -\s*/g, "")
      .replace(/JIAN CHA Tea 见茶山 เจี้ยนชา -\s*/g, "")
      .replace(/\[CLOSE UP\]\s*/g, "")
      .trim();

  const masterDone = all.filter((b) => b.captured && b.isMaster).sort((a, b) => clean(a.name).localeCompare(clean(b.name)));
  const fcDone = all.filter((b) => b.captured && !b.isMaster).sort((a, b) => clean(a.name).localeCompare(clean(b.name)));
  const notYet = all.filter((b) => !b.captured).sort((a, b) => clean(a.name).localeCompare(clean(b.name)));

  console.log(`\n══════════════════════════════════════════════════════════════════`);
  console.log(` รายชื่อสาขาทั้งหมด — ${all.length} สาขา`);
  console.log(`══════════════════════════════════════════════════════════════════\n`);

  console.log(`⭐ MASTER ที่ capture แล้ว — ${masterDone.length} สาขา`);
  console.log(`──────────────────────────────────────────────────────────────`);
  masterDone.forEach((b, i) => {
    const num = String(i + 1).padStart(2, " ");
    const items = String(b.itemCount).padStart(3, " ");
    console.log(`  ${num}. ✓  ${clean(b.name).slice(0, 50).padEnd(50, " ")}  ${items} เมนู`);
  });

  console.log(`\n🏪 FRANCHISE ที่ capture แล้ว — ${fcDone.length} สาขา`);
  console.log(`──────────────────────────────────────────────────────────────`);
  fcDone.forEach((b, i) => {
    const num = String(i + 1).padStart(2, " ");
    const items = String(b.itemCount).padStart(3, " ");
    console.log(`  ${num}. ✓  ${clean(b.name).slice(0, 50).padEnd(50, " ")}  ${items} เมนู`);
  });

  if (notYet.length > 0) {
    console.log(`\n⚠️  ยังไม่มี data — ${notYet.length} สาขา`);
    console.log(`──────────────────────────────────────────────────────────────`);
    notYet.forEach((b, i) => {
      const num = String(i + 1).padStart(2, " ");
      const owner = b.isMaster ? "⭐" : "FC";
      console.log(`  ${num}. ✗  ${owner} ${clean(b.name).slice(0, 47).padEnd(47, " ")}  ← ${b.reason}`);
    });
  }

  console.log(`\n══════════════════════════════════════════════════════════════════`);
  console.log(`  สรุป: ⭐ ${masterDone.length} + 🏪 ${fcDone.length} + ⚠️ ${notYet.length} = ${all.length}`);
  console.log(`══════════════════════════════════════════════════════════════════\n`);
})().catch((e) => { console.error(e); process.exit(1); });
