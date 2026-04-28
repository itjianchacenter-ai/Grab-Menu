#!/usr/bin/env node
"use strict";
/**
 * Discovery: ใช้ Playwright login แต่ละสาขาเพื่อ "ค้น" merchant ID
 * จากนั้นบันทึกเข้า vault.enc โดยอัตโนมัติ
 *
 * Usage:
 *   node discover.js <input.csv>
 *   CSV columns: username, password, [name]
 *
 * แต่ละสาขา:
 *   1. login → ไปหน้า merchant
 *   2. แกะ ID จาก URL หรือ DOM
 *   3. แกะชื่อสาขาจาก page
 *   4. ใส่ลง vault.enc (เพิ่ม/อัปเดต)
 */
require("dotenv").config({ path: require("path").resolve(__dirname, ".env") });

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { load: loadVault, save: saveVault } = require("./vault");
const { parseCsv } = require("./vault-cli");
const { isLoggedIn, login } = require("./login");

const DELAY_MIN = Number(process.env.DELAY_MIN || 10);
const DELAY_MAX = Number(process.env.DELAY_MAX || 30);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomDelay = () =>
  Math.round((DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN)) * 1000);

const ID_REGEX = /\b(\d+-[A-Z0-9]{10,})\b/;

async function discoverOne(context, entry, idx, total) {
  console.log(`\n[${idx + 1}/${total}] ${entry.name || entry.username}`);
  const page = await context.newPage();
  let id = null;
  let pageName = null;

  try {
    // เปิดหน้า merchant — Grab จะ redirect ไป login ถ้ายังไม่ได้ login
    await page.goto("https://merchant.grab.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(2000);

    if (!(await isLoggedIn(page))) {
      await login(page, { username: entry.username, password: entry.password });
    }

    // หา ID จาก URL ปัจจุบัน
    id = extractFromUrl(page.url());

    // ถ้าไม่เจอ — ลอง click menu link หรือไปที่ /food
    if (!id) {
      await page.goto("https://merchant.grab.com/food/menu", { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(3000);
      id = extractFromUrl(page.url());
    }

    // ถ้ายังไม่เจอ — scrape จาก HTML (อาจอยู่ใน data attribute / inline script)
    if (!id) {
      const html = await page.content();
      const m = html.match(ID_REGEX);
      if (m) id = m[1];
    }

    // หา name จาก page (h1, h2, หรือ title)
    pageName = await page
      .locator("h1, h2, [class*='merchantName'], [class*='restaurantName']")
      .first()
      .textContent({ timeout: 2000 })
      .then((t) => (t || "").trim().slice(0, 100))
      .catch(() => null);

    if (!id) throw new Error("ไม่พบ merchant ID หลัง login (อาจเป็น account ที่ไม่ได้ผูกร้าน)");

    console.log(`  ✓ id=${id}  name=${pageName || "(ใช้ชื่อจาก CSV)"}`);
    return { ok: true, id, name: pageName || entry.name || id };
  } catch (err) {
    console.log(`  ✗ ${err.message}`);
    return { ok: false, error: err.message };
  } finally {
    await page.close().catch(() => {});
  }
}

function extractFromUrl(url) {
  const m = url.match(ID_REGEX);
  return m ? m[1] : null;
}

async function main() {
  const csvFile = process.argv[2];
  if (!csvFile) {
    console.error("Usage: node discover.js <input.csv>");
    console.error("CSV columns: username, password, [name]");
    process.exit(1);
  }

  const text = fs.readFileSync(csvFile, "utf8");
  const entries = parseCsvLoose(text);
  if (entries.length === 0) {
    console.error("ไม่มี entries ใน CSV");
    process.exit(1);
  }
  console.log(`Discovery: ${entries.length} accounts`);

  const profileDir = path.join(__dirname, "profiles", "_discovery");
  fs.mkdirSync(profileDir, { recursive: true });

  const launchOpts = {
    headless: false,
    args: ["--no-first-run", "--no-default-browser-check"],
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

  // โหลด vault เดิม (อาจมีบางสาขาอยู่แล้ว)
  let vault;
  try {
    vault = loadVault();
  } catch (err) {
    console.error("Vault error:", err.message);
    process.exit(1);
  }
  const existing = new Map(vault.branches.map((b) => [b.username.toLowerCase(), b]));

  const results = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const r = await discoverOne(context, e, i, entries.length);
    results.push({ ...e, ...r });

    if (r.ok) {
      const branch = {
        id: r.id,
        name: r.name,
        username: e.username,
        password: e.password,
      };
      existing.set(e.username.toLowerCase(), branch);
    }

    // Logout ก่อนสาขาถัดไป
    await context.clearCookies().catch(() => {});

    if (i < entries.length - 1) {
      const d = randomDelay();
      console.log(`  💤 sleep ${(d / 1000).toFixed(0)}s`);
      await sleep(d);
    }
  }

  await context.close().catch(() => {});

  // บันทึก vault
  const newBranches = [...existing.values()];
  saveVault({ branches: newBranches });

  // สรุปผล
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n=== Summary ===`);
  console.log(`✓ ${ok}/${results.length} discovered`);
  if (ok < results.length) {
    console.log(`✗ Failed:`);
    results.filter((r) => !r.ok).forEach((r) => console.log(`  - ${r.username}: ${r.error}`));
  }
  console.log(`\nVault now has ${newBranches.length} branches.`);
  console.log(`⚠️  ลบไฟล์ ${csvFile} ทันที: rm "${csvFile}"`);
}

function parseCsvLoose(text) {
  // เหมือน parseCsv แต่ id ไม่บังคับ — แค่ username + password
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return [];
  const header = lines[0].split(",").map((s) => s.trim().toLowerCase());
  const required = ["username", "password"];
  for (const r of required) {
    if (!header.includes(r)) throw new Error(`CSV ขาด column: ${r}`);
  }
  return lines.slice(1).map((line) => {
    // simple split ไม่รองรับ quoted comma — ถ้า password มี comma ใช้ JSON import แทน
    const fields = line.split(",");
    const row = {};
    header.forEach((h, idx) => (row[h] = (fields[idx] || "").trim()));
    return row;
  }).filter((r) => r.username && r.password && !/example|ตัวอย่าง/i.test(r.username));
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
