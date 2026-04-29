#!/usr/bin/env node
"use strict";
/**
 * Multi-branch CDP runner สำหรับ master account ที่ login เดียวเข้าได้หลายสาขา
 *
 * Logic:
 *   1. ไปที่ /dashboard
 *   2. คลิก dropdown "ทุกร้าน"
 *   3. เลือกสาขา (text match)
 *   4. รอ session อัปเดต
 *   5. นำทางไปที่ /food/menu/<id>/menuOverview → extension จับ
 *
 * Usage:
 *   node multi-branch-runner.js                  # all active branches in vault
 *   node multi-branch-runner.js 3-XXX 3-YYY     # specific
 */

require("dotenv").config({ path: require("path").resolve(__dirname, ".env") });

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { load: loadVault } = require("./vault");

const CDP_URL = process.env.CDP_URL || "http://localhost:9222";
const SYNC_SERVER = process.env.SYNC_SERVER || "http://localhost:8765";
const DELAY_MIN = Number(process.env.DELAY_MIN || 5);
const DELAY_MAX = Number(process.env.DELAY_MAX || 15);
const WAIT_AFTER_OPEN = Number(process.env.WAIT_AFTER_OPEN || 12);

const LOGS_DIR = path.resolve(__dirname, "logs");
fs.mkdirSync(LOGS_DIR, { recursive: true });
const logFile = path.join(LOGS_DIR, `multi-runner-${new Date().toISOString().slice(0, 10)}.log`);
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(String).join(" ")}`;
  console.log(line);
  try {
    fs.appendFileSync(logFile, line + "\n");
  } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomDelay = () => Math.round((DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN)) * 1000);

async function selectBranch(page, branch) {
  // Always navigate to /dashboard fresh — gives us a clean dropdown state
  await page.goto("https://merchant.grab.com/dashboard", { waitUntil: "domcontentloaded" });
  await sleep(3500);

  const m = (branch.name || "").match(/-\s*(.+?)(?:\s+[\u0E00-\u0E7F]|$)/);
  const keyword = m ? m[1].trim().split(/\s+/)[0] : branch.name;

  log(`  🔽 opening dropdown, looking for "${keyword}"`);

  // Find the active store-selector input (it could have any placeholder/value)
  // Common patterns:
  //  - <input> next to "ทุกบริการ Grab" select
  //  - <input role="combobox">
  //  - inside a div with class containing "store" or "merchant"
  const dropdownInput = page
    .locator('input[role="combobox"], input[autocomplete="off"]')
    .nth(1); // typically [0] is service-selector, [1] is store-selector

  try {
    await dropdownInput.click({ timeout: 5000 });
  } catch (err) {
    // Fallback: click any element with "ทุกร้าน" text (initial state)
    try {
      await page.locator('text=ทุกร้าน').first().click({ timeout: 3000 });
    } catch (_) {
      throw new Error(`dropdown trigger not found: ${err.message}`);
    }
  }
  await sleep(700);

  // Clear + type to filter the list
  try {
    await dropdownInput.fill("");
    await sleep(200);
    await dropdownInput.type(keyword, { delay: 50 });
    await sleep(900);
  } catch (_) {}

  // Click the first matching option using a robust selector chain
  const optionSelectors = [
    `[role="option"]:has-text("${keyword}")`,
    `li:has-text("${keyword}")`,
    `[class*="option"]:has-text("${keyword}")`,
    `[class*="MenuItem"]:has-text("${keyword}")`,
    `div:has-text("- ${keyword}")`,
  ];

  let clicked = false;
  for (const sel of optionSelectors) {
    try {
      const opt = page.locator(sel).first();
      if (await opt.isVisible({ timeout: 1500 })) {
        await opt.click({ timeout: 3000 });
        clicked = true;
        log(`  ✓ selected via: ${sel.slice(0, 60)}`);
        break;
      }
    } catch (_) {}
  }

  if (!clicked) {
    // Save screenshot for debugging
    try {
      const f = path.join(LOGS_DIR, `selectfail-${branch.id}-${Date.now()}.png`);
      await page.screenshot({ path: f });
      log(`  💾 screenshot: ${f}`);
    } catch (_) {}
    throw new Error(`couldn't click branch option for "${keyword}"`);
  }

  await sleep(2500);
}

async function captureBranch(context, page, branch) {
  const url = `https://merchant.grab.com/food/menu/${branch.id}/menuOverview`;
  const beforeTs = Date.now();

  // Step 1: select branch via dropdown
  try {
    await selectBranch(page, branch);
  } catch (err) {
    log(`  ✗ select failed: ${err.message}`);
    return { ok: false, error: `select failed: ${err.message}` };
  }

  // Step 2: navigate to menu URL
  try {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  } catch {}
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await sleep(2000);

  const finalUrl = page.url();
  if (!finalUrl.includes(branch.id)) {
    log(`  ⚠ redirected to ${finalUrl}`);
    return { ok: false, error: "redirected" };
  }

  // Step 3: wait for extension to capture
  log(`  ⏳ waiting ${WAIT_AFTER_OPEN}s for extension capture…`);
  await sleep(WAIT_AFTER_OPEN * 1000);

  // Step 4: verify
  try {
    const res = await fetch(`${SYNC_SERVER}/api/data`, { cache: "no-store" });
    const data = await res.json();
    const m = data.merchants?.[branch.id];
    if (m && m.lastFetched && m.lastFetched >= beforeTs) {
      return { ok: true, count: m.items?.length || 0 };
    }
  } catch {}
  return { ok: false, error: "no-data" };
}

async function main() {
  log(`Connecting to Chrome at ${CDP_URL}`);
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  if (!context) {
    log("❌ No context");
    process.exit(1);
  }

  const vault = loadVault();
  let branches = vault.branches.filter((b) => !/\[CLOSE\s*(UP|DOWN)\]/i.test(b.name || ""));
  const args = process.argv.slice(2);
  if (args.length > 0) branches = branches.filter((b) => args.includes(b.id));

  log(`Processing ${branches.length} branches via dropdown switch`);

  const pages = context.pages();
  const page = pages.find((p) => p.url().includes("merchant.grab.com")) || pages[0] || (await context.newPage());

  page.on("console", (msg) => {
    const t = msg.text();
    if (t.includes("[grab-menu") || t.includes("✅") || t.includes("synced")) {
      log(`    [chrome] ${t.slice(0, 200)}`);
    }
  });

  const results = [];
  for (let i = 0; i < branches.length; i++) {
    const b = branches[i];
    log(`\n[${i + 1}/${branches.length}] ${b.name?.slice(0, 60) || b.id}`);
    const r = await captureBranch(context, page, b).catch((err) => ({ ok: false, error: err.message }));
    if (r.ok) log(`  ✓ ${r.count} items`);
    else log(`  ✗ ${r.error}`);
    results.push({ branch: b, ...r });

    if (i < branches.length - 1) {
      const d = randomDelay();
      log(`  💤 sleep ${(d / 1000).toFixed(0)}s`);
      await sleep(d);
    }
  }

  await browser.close();

  const ok = results.filter((r) => r.ok).length;
  log(`\n═══ Done ═══`);
  log(`✓ ${ok}/${results.length} synced`);
  results.filter((r) => !r.ok).forEach((r) => log(`  ✗ ${r.branch.id}: ${r.error}`));
}

main().catch((err) => {
  log(`Fatal: ${err.message}`);
  process.exit(1);
});
