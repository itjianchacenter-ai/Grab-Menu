#!/usr/bin/env node
"use strict";
require("dotenv").config({ path: require("path").resolve(__dirname, ".env") });
const { load } = require("./vault");
const fs = require("fs");
const path = require("path");

(async () => {
  const v = await load();
  const vault = v.entries || v.branches || [];
  const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../server-data.json"), "utf8"));
  const captured = new Set(Object.keys(data.merchants || {}));

  const groups = new Map();
  for (const e of vault) {
    const u = e.username;
    if (!groups.has(u)) groups.set(u, []);
    groups.get(u).push(e);
  }

  const accounts = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  let totalDone = 0, totalPending = 0;

  console.log(`\n══ บัญชี Login: ${accounts.length} accounts │ สาขา Vault: ${vault.length} │ Capture: ${captured.size} ══\n`);

  const extras = [...captured].filter(id => !vault.find(e => e.id === id));

  for (const [u, list] of accounts) {
    const done = list.filter(e => captured.has(e.id)).length;
    const total = list.length;
    const status = done === total ? "✅" : done > 0 ? "🟡" : "⚪";
    console.log(`${status} ${u}  (${done}/${total})`);
    for (const e of list) {
      const ok = captured.has(e.id) ? "✓" : " ";
      const name = (e.name || "?")
        .replace(/Jian cha Tea 见茶山\(เจี้ยนชา\) -\s*/g, "")
        .replace(/JIANCHA TEA \(เจี้ยนชา\) -\s*/g, "")
        .replace(/JIAN CHA Tea 见茶山 เจี้ยนชา -\s*/g, "")
        .trim();
      console.log(`    [${ok}] ${e.id}  ${name.slice(0, 60)}`);
      if (captured.has(e.id)) totalDone++; else totalPending++;
    }
  }
  if (extras.length) {
    console.log(`\n📌 จาก master account (ไม่อยู่ใน vault): ${extras.length}`);
    for (const id of extras) {
      const m = data.merchants[id];
      console.log(`    [✓] ${id}  ${(m.name || "?").slice(0, 60)}`);
    }
  }
  console.log(`\n══ สรุป: เสร็จ ${totalDone + extras.length} │ ค้าง ${totalPending} ══`);
})().catch(e => { console.error(e); process.exit(1); });
