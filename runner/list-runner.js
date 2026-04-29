#!/usr/bin/env node
"use strict";
/**
 * List runner — ใช้หน้า /food/menu (รายการสาขาทั้งหมด)
 * แทนการ click dropdown
 *
 * Logic:
 *   1. ไปที่ /food/menu
 *   2. ดึงรายการ row ทั้งหมด
 *   3. ข้าม row ที่มี "[CLOSE UP]" หรือ "[CLOSE DOWN]"
 *   4. คลิก row → page นำไปที่ /food/menu/<id>/menuOverview
 *   5. รอให้ extension จับ
 *   6. กดย้อนกลับ → คลิก row ถัดไป
 *
 * Usage:
 *   node list-runner.js
 */

require("dotenv").config({ path: require("path").resolve(__dirname, ".env") });

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const CDP_URL = process.env.CDP_URL || "http://localhost:9222";
const SYNC_SERVER = process.env.SYNC_SERVER || "http://localhost:8765";
const WAIT_AFTER_OPEN = Number(process.env.WAIT_AFTER_OPEN || 12);

const LOGS_DIR = path.resolve(__dirname, "logs");
fs.mkdirSync(LOGS_DIR, { recursive: true });
const logFile = path.join(LOGS_DIR, `list-runner-${new Date().toISOString().slice(0, 10)}.log`);
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(String).join(" ")}`;
  console.log(line);
  try {
    fs.appendFileSync(logFile, line + "\n");
  } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getBranchList(page) {
  await page.goto("https://merchant.grab.com/food/menu", { waitUntil: "domcontentloaded" });
  await sleep(3500);

  // Extract branch info from the list rows. Each row should be clickable and
  // contain the branch name plus an internal click handler that navigates to /food/menu/<id>/menuOverview
  const branches = await page.evaluate(() => {
    const rows = Array.from(
      document.querySelectorAll('[role="row"], tr, [class*="row" i], [class*="MerchantRow" i]'),
    );
    const out = [];
    for (const row of rows) {
      const text = row.textContent || "";
      // Skip header
      if (/^(ชื่อร้าน|name)/i.test(text.trim())) continue;
      if (!text.trim()) continue;
      // Extract first clickable name area — first cell or a heading
      const nameEl =
        row.querySelector('[class*="name"]') ||
        row.querySelector("td:first-child") ||
        row.querySelector('[role="cell"]:first-child') ||
        row;
      const name = (nameEl?.textContent || "").trim().slice(0, 200);
      if (!name) continue;
      out.push({ name });
    }
    // Dedupe by name
    const seen = new Set();
    return out.filter((b) => {
      if (seen.has(b.name)) return false;
      seen.add(b.name);
      return true;
    });
  });

  return branches;
}

async function clickRowByName(page, name) {
  // Try exact text match first, then partial
  const sels = [
    `[role="row"]:has-text("${name}")`,
    `tr:has-text("${name}")`,
    `[class*="row"]:has-text("${name}")`,
  ];
  for (const sel of sels) {
    const loc = page.locator(sel).first();
    try {
      if (await loc.isVisible({ timeout: 1500 })) {
        await loc.click({ timeout: 3000 });
        return true;
      }
    } catch {}
  }
  return false;
}

async function captureCurrentBranch(page) {
  const beforeTs = Date.now();

  // Wait for URL to change to a menu page
  try {
    await page.waitForURL(/\/food\/menu\/3-[A-Z0-9]{10,}/, { timeout: 10_000 });
  } catch {
    return { ok: false, error: "no-navigation" };
  }
  const url = page.url();
  const m = url.match(/3-[A-Z0-9]{10,}/);
  const branchId = m ? m[0] : null;
  log(`  📍 navigated to ${branchId}`);

  log(`  ⏳ wait ${WAIT_AFTER_OPEN}s for capture…`);
  await sleep(WAIT_AFTER_OPEN * 1000);

  if (!branchId) return { ok: false, error: "no-branchId" };

  try {
    const res = await fetch(`${SYNC_SERVER}/api/data`, { cache: "no-store" });
    const data = await res.json();
    const merchant = data.merchants?.[branchId];
    if (merchant && merchant.lastFetched && merchant.lastFetched >= beforeTs) {
      return { ok: true, branchId, count: merchant.items?.length || 0, name: merchant.name };
    }
  } catch {}
  return { ok: false, error: "no-fresh-data", branchId };
}

async function main() {
  log(`Connecting to Chrome at ${CDP_URL}`);
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  const pages = context.pages();
  const page =
    pages.find((p) => p.url().includes("merchant.grab.com")) || pages[0] || (await context.newPage());

  page.on("console", (msg) => {
    const t = msg.text();
    if (t.includes("✅") || t.includes("🔄") || t.includes("synced")) {
      log(`    [chrome] ${t.slice(0, 180)}`);
    }
  });

  log("Loading branch list from /food/menu");
  let branchList = await getBranchList(page);
  log(`Found ${branchList.length} rows`);

  // Filter out closed branches
  branchList = branchList.filter((b) => !/\[CLOSE\s*(UP|DOWN)\]/i.test(b.name));
  log(`After filter: ${branchList.length} active rows\n`);
  for (const b of branchList) log(`  • ${b.name.slice(0, 80)}`);
  log("");

  const results = [];
  for (let i = 0; i < branchList.length; i++) {
    const b = branchList[i];
    log(`\n[${i + 1}/${branchList.length}] ${b.name.slice(0, 60)}`);

    // Always start from the list page
    if (!page.url().endsWith("/food/menu")) {
      await page.goto("https://merchant.grab.com/food/menu", { waitUntil: "domcontentloaded" });
      await sleep(2500);
    }

    const clicked = await clickRowByName(page, b.name.slice(0, 50));
    if (!clicked) {
      log(`  ✗ couldn't click row`);
      results.push({ name: b.name, ok: false, error: "click-failed" });
      continue;
    }

    const r = await captureCurrentBranch(page);
    if (r.ok) {
      log(`  ✓ ${r.name?.slice(0, 50)} — ${r.count} items`);
    } else {
      log(`  ✗ ${r.error}`);
    }
    results.push({ name: b.name, ...r });

    await sleep(3000);
  }

  await browser.close();

  log(`\n═══ Done ═══`);
  log(`✓ ${results.filter((r) => r.ok).length} / ${results.length} synced`);
}

main().catch((err) => {
  log(`Fatal: ${err.message}`);
  console.error(err);
  process.exit(1);
});
