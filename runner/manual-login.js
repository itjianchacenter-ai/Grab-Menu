#!/usr/bin/env node
"use strict";
/**
 * Manual login mode — เปิด Chrome ให้ login ทีละสาขา (ครั้งเดียว)
 * จากนั้น cookie ถูกเก็บใน profile ของสาขานั้น runner ใช้ต่อได้
 *
 * Usage:
 *   node manual-login.js                # login ทุกสาขา (เลือกได้)
 *   node manual-login.js <branchId>     # login เฉพาะสาขาที่ระบุ
 *   node manual-login.js --pending      # เฉพาะสาขาที่ยังไม่มี cookie
 */

require("dotenv").config({ path: require("path").resolve(__dirname, ".env") });

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
chromium.use(stealth);
const { load: loadVault } = require("./vault");

const EXT_PATH = path.resolve(__dirname, "..", "extension");
const PROFILES_DIR = path.resolve(__dirname, "profiles");

function ask(q) {
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => {
      rl.close();
      res(a.trim());
    });
  });
}

function profileHasCookies(branchId) {
  const dir = path.join(PROFILES_DIR, branchId);
  // Look for the Cookies SQLite file Chrome creates
  const candidates = [
    path.join(dir, "Default", "Cookies"),
    path.join(dir, "Default", "Network", "Cookies"),
  ];
  return candidates.some((p) => {
    try {
      return fs.statSync(p).size > 1024;
    } catch {
      return false;
    }
  });
}

async function loginOne(branch) {
  const profileDir = path.join(PROFILES_DIR, branch.id);
  fs.mkdirSync(profileDir, { recursive: true });

  console.log(`\n═══════════════════════════════════════════════════════`);
  console.log(`  ${branch.name || branch.id}`);
  console.log(`  user: ${branch.username}`);
  console.log(`  pass: ${branch.password}`);
  console.log(`═══════════════════════════════════════════════════════`);

  const launchOpts = {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
    viewport: { width: 1280, height: 800 },
  };
  let context;
  try {
    launchOpts.channel = "chrome";
    context = await chromium.launchPersistentContext(profileDir, launchOpts);
  } catch (_) {
    delete launchOpts.channel;
    context = await chromium.launchPersistentContext(profileDir, launchOpts);
  }

  const page = context.pages()[0] || (await context.newPage());
  const menuUrl = `https://merchant.grab.com/food/menu/${branch.id}/menuOverview`;
  await page.goto(menuUrl, { waitUntil: "domcontentloaded" }).catch(() => {});

  console.log(`\n👉 ทำ 3 ขั้นใน Chrome ที่เปิดมา:`);
  console.log(`   1. Login ด้วย ${branch.username} / ${branch.password}`);
  console.log(`   2. รอจนเห็นหน้าเมนูจริง (URL ควรมี ${branch.id})`);
  console.log(`   3. กลับมา Terminal นี้ → กด Enter`);
  console.log(`\n(ถ้าจะข้ามสาขานี้ พิมพ์ "skip" แล้ว Enter)`);

  const ans = await ask("> ");
  await context.close();

  if (ans.toLowerCase() === "skip") {
    console.log(`  ⏭ skipped`);
    return { ok: false, skipped: true };
  }

  // Verify cookies were saved
  if (profileHasCookies(branch.id)) {
    console.log(`  ✓ cookies saved`);
    return { ok: true };
  } else {
    console.log(`  ⚠ no cookies detected — login อาจไม่สำเร็จ`);
    return { ok: false, reason: "no-cookies-saved" };
  }
}

async function main() {
  const arg = process.argv[2];

  let vault;
  try {
    vault = loadVault();
  } catch (err) {
    console.error("Vault error:", err.message);
    process.exit(1);
  }

  let branches = vault.branches;
  if (arg && arg !== "--pending") {
    branches = branches.filter((b) => b.id === arg);
    if (branches.length === 0) {
      console.error(`Branch ${arg} not in vault`);
      process.exit(1);
    }
  } else if (arg === "--pending") {
    branches = branches.filter((b) => !profileHasCookies(b.id));
  }

  // Skip closed branches
  branches = branches.filter((b) => !/\[CLOSE\s*(UP|DOWN)\]/i.test(b.name || ""));

  console.log(`\n📋 ${branches.length} branches to login\n`);
  if (branches.length > 5) {
    const ans = await ask(`Login ทั้ง ${branches.length} สาขา? (yes/no): `);
    if (ans.toLowerCase() !== "yes" && ans.toLowerCase() !== "y") {
      console.log("Cancelled.");
      process.exit(0);
    }
  }

  const results = [];
  for (let i = 0; i < branches.length; i++) {
    const b = branches[i];
    console.log(`\n[${i + 1}/${branches.length}]`);
    const r = await loginOne(b);
    results.push({ branch: b, ...r });
  }

  const ok = results.filter((r) => r.ok).length;
  const skipped = results.filter((r) => r.skipped).length;
  console.log(`\n═══ Summary ═══`);
  console.log(`✓ Logged in: ${ok}`);
  console.log(`⏭ Skipped:   ${skipped}`);
  console.log(`✗ Failed:    ${results.length - ok - skipped}`);
  console.log(`\nNext: node index.js`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
