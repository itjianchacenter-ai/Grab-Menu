#!/usr/bin/env node
"use strict";
/**
 * chrome-cdp-runner — เชื่อมต่อ Chrome (จริง) ผ่าน DevTools Protocol
 * Chrome ต้อง start ก่อนด้วย launch-chrome.sh
 *
 * ใช้:
 *   node chrome-cdp-runner.js                # ทุกสาขา
 *   node chrome-cdp-runner.js 3-XXXXXXXXX    # สาขาเดียว
 *   BRANCHES_LIMIT=3 node chrome-cdp-runner.js
 */

require("dotenv").config({ path: require("path").resolve(__dirname, ".env") });

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { load: loadVault } = require("./vault");

const CDP_URL = process.env.CDP_URL || "http://localhost:9222";
const SYNC_SERVER = process.env.SYNC_SERVER || "http://localhost:8765";
const DELAY_MIN = Number(process.env.DELAY_MIN || 10);
const DELAY_MAX = Number(process.env.DELAY_MAX || 30);
const BRANCHES_LIMIT = Number(process.env.BRANCHES_LIMIT || 0);
const WAIT_AFTER_OPEN = Number(process.env.WAIT_AFTER_OPEN || 15);

const LOGS_DIR = path.resolve(__dirname, "logs");
fs.mkdirSync(LOGS_DIR, { recursive: true });
const logFile = path.join(LOGS_DIR, `cdp-runner-${new Date().toISOString().slice(0, 10)}.log`);
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(String).join(" ")}`;
  console.log(line);
  try {
    fs.appendFileSync(logFile, line + "\n");
  } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomDelay = () => Math.round((DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN)) * 1000);

async function verifySynced(branchId, beforeTs) {
  try {
    const res = await fetch(`${SYNC_SERVER}/api/data`, { cache: "no-store" });
    if (!res.ok) return null;
    const data = await res.json();
    const m = data.merchants?.[branchId];
    if (!m) return null;
    if (beforeTs && m.lastFetched && m.lastFetched < beforeTs) return null;
    return { itemCount: m.items?.length || 0 };
  } catch (_) {
    return null;
  }
}

async function processBranch(context, branch, sharedPage) {
  const url = `https://merchant.grab.com/food/menu/${branch.id}/menuOverview`;
  const beforeTs = Date.now();

  // Reuse the shared tab — extension state stays consistent (no fresh tab init each time)
  const page = sharedPage;

  try {
    // Disable cache so the menu API is always re-fetched
    try {
      const cdp = await context.newCDPSession(page);
      await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    } catch {}
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  } catch (err) {
    log(`  ✗ navigation failed: ${err.message}`);
    return { ok: false, error: "nav-failed" };
  }

  // Wait for SPA to render and possibly redirect
  await sleep(4000);
  const finalUrl = page.url();
  log(`  🔗 URL: ${finalUrl}`);

  if (!finalUrl.includes(branch.id)) {
    log(`  ⚠ not on branch URL — login needed for ${branch.username}`);
    return { ok: false, error: `login needed (${branch.username})` };
  }

  log(`  ⏳ waiting ${WAIT_AFTER_OPEN}s for extension capture…`);
  await sleep(WAIT_AFTER_OPEN * 1000);

  return verifySynced(branch.id, beforeTs).then((verified) => {
    if (verified) return { ok: true, count: verified.itemCount };
    return { ok: false, error: "no-data" };
  });

  if (verified) {
    log(`  ✓ synced ${verified.itemCount} items`);
    return { ok: true };
  } else {
    log(`  ⚠ no fresh data (extension may have failed to capture)`);
    return { ok: false, error: "no-data" };
  }
}

async function main() {
  log(`Connecting to Chrome at ${CDP_URL}`);
  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch (err) {
    log(`❌ Cannot connect to Chrome at ${CDP_URL}`);
    log(`   Run launch-chrome.sh first:  bash launch-chrome.sh`);
    process.exit(1);
  }
  const context = browser.contexts()[0];
  if (!context) {
    log(`❌ No browser context found`);
    process.exit(1);
  }
  log(`✓ Connected — ${context.pages().length} page(s) currently open`);

  const vault = loadVault();
  const targetId = process.argv[2];
  let branches = vault.branches.filter((b) => !/\[CLOSE\s*(UP|DOWN)\]/i.test(b.name || ""));
  if (targetId) {
    branches = branches.filter((b) => b.id === targetId);
    if (branches.length === 0) {
      log(`Branch ${targetId} not in vault`);
      browser.close();
      process.exit(1);
    }
  } else if (BRANCHES_LIMIT > 0) {
    branches = branches.slice(0, BRANCHES_LIMIT);
  }

  log(`Processing ${branches.length} branches`);

  // Reuse a single tab across all branches — extension state stays warm
  const existingPages = context.pages();
  const sharedPage = existingPages[0] || (await context.newPage());

  // Tap into page console — shows extension [grab-menu] logs to help debug capture failures
  sharedPage.on("console", (msg) => {
    const t = msg.text();
    if (t.includes("[grab-menu") || t.includes("✅") || t.includes("📦") || t.includes("synced")) {
      log(`    [chrome] ${t.slice(0, 200)}`);
    }
  });

  const results = [];
  for (let i = 0; i < branches.length; i++) {
    const b = branches[i];
    log(`\n[${i + 1}/${branches.length}] ${b.name || b.id}`);
    let r;
    try {
      r = await processBranch(context, b, sharedPage);
    } catch (err) {
      r = { ok: false, error: err.message };
    }
    results.push({ branch: b, ...r });
    if (r.ok) log(`  ✓ ${r.count} items`);

    if (i < branches.length - 1) {
      const d = randomDelay();
      log(`  💤 sleep ${(d / 1000).toFixed(0)}s`);
      await sleep(d);
    }
  }

  await browser.close(); // disconnects, doesn't kill Chrome

  const ok = results.filter((r) => r.ok).length;
  log(`\n═══ Summary ═══`);
  log(`✓ Synced: ${ok}/${results.length}`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    log(`✗ Failed:`);
    for (const f of failed) {
      log(`   ${f.branch.id}  ${(f.branch.name || "").slice(0, 50)}  — ${f.error}`);
    }
  }
}

main().catch((err) => {
  log(`Fatal: ${err.message}`);
  console.error(err);
  process.exit(1);
});
