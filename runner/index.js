#!/usr/bin/env node
"use strict";
/**
 * Main orchestrator.
 *
 * For each branch in the encrypted vault:
 *   1. Launch Chrome with persistent profile + the existing extension
 *   2. Navigate to merchant.grab.com/food/menu/<id>/menuOverview
 *   3. If redirected to login, run login flow with stored credentials
 *   4. Wait for extension to capture menu and POST to local sync server
 *   5. Verify capture succeeded by polling /api/data
 *   6. Close browser
 *   7. Random delay → next branch
 */

require("dotenv").config({ path: require("path").resolve(__dirname, ".env") });

const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
chromium.use(stealth);
const { load: loadVault } = require("./vault");
const { isLoggedIn, login } = require("./login");

const EXT_PATH = path.resolve(__dirname, "..", "extension");
const PROFILES_DIR = path.resolve(__dirname, "profiles");
const LOGS_DIR = path.resolve(__dirname, "logs");
const SYNC_SERVER = process.env.SYNC_SERVER || "http://localhost:8765";
const HEADLESS = process.env.HEADLESS === "true";
const DELAY_MIN = Number(process.env.DELAY_MIN || 20);
const DELAY_MAX = Number(process.env.DELAY_MAX || 60);
const BRANCHES_LIMIT = Number(process.env.BRANCHES_LIMIT || 0);
const RETRY_ATTEMPTS = Number(process.env.RETRY_ATTEMPTS || 3);

fs.mkdirSync(PROFILES_DIR, { recursive: true });
fs.mkdirSync(LOGS_DIR, { recursive: true });

const logFile = path.join(LOGS_DIR, `runner-${new Date().toISOString().slice(0, 10)}.log`);
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(String).join(" ")}`;
  console.log(line);
  try {
    fs.appendFileSync(logFile, line + "\n");
  } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomDelay = () =>
  Math.round((DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN)) * 1000);

async function processBranch(branch, attempt = 1) {
  // Skip closed branches automatically
  if (/\[CLOSE\s*(UP|DOWN)\]/i.test(branch.name || "")) {
    log(`  ↪ skipping closed branch: ${branch.name}`);
    return;
  }

  const profileDir = path.join(PROFILES_DIR, branch.id);
  fs.mkdirSync(profileDir, { recursive: true });

  log(`▶ ${branch.name || branch.id}  (attempt ${attempt}/${RETRY_ATTEMPTS})`);

  const launchOpts = {
    headless: HEADLESS,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
    viewport: { width: 1280, height: 800 },
  };
  // Prefer system Chrome (more "real" fingerprint than bundled Chromium)
  try {
    launchOpts.channel = "chrome";
  } catch (_) {}

  let context;
  try {
    context = await chromium.launchPersistentContext(profileDir, launchOpts);
  } catch (err) {
    // Fallback to bundled Chromium if Chrome channel not available
    delete launchOpts.channel;
    context = await chromium.launchPersistentContext(profileDir, launchOpts);
  }

  try {
    const page = context.pages()[0] || (await context.newPage());

    // Optional: capture console logs from the page (debug)
    if (process.env.DEBUG === "true") {
      page.on("console", (m) => log(`    [page] ${m.type()}: ${m.text().slice(0, 200)}`));
    }

    const menuUrl = `https://merchant.grab.com/food/menu/${branch.id}/menuOverview`;
    log(`  🌐 navigating to menu`);
    await page.goto(menuUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

    // Wait for extension to capture and POST. Don't reload, don't clear cookies —
    // trust the persistent profile. If session expired, we'll detect via verifySynced
    // and the user can re-run manual-login for that branch.
    log("  ⏳ waiting for extension to capture (18s)…");
    await page.waitForTimeout(18_000);

    log(`  🔗 final URL: ${page.url()}`);

    // Verify by polling /api/data
    const verified = await verifySynced(branch.id);
    if (verified) {
      log(`  ✓ ${branch.name} synced (${verified.itemCount} items)`);
    } else {
      log(`  ⚠ no data confirmed for ${branch.id}`);
      // Save diagnostic info: screenshot + final URL + page title
      await saveDiagnostic(page, branch, attempt).catch(() => {});
      throw new Error("no-data-after-capture");
    }
  } finally {
    await context.close().catch(() => {});
  }
}

async function saveDiagnostic(page, branch, attempt) {
  const dir = path.join(LOGS_DIR, "diagnostic");
  fs.mkdirSync(dir, { recursive: true });
  const stem = `${branch.id}-attempt${attempt}-${Date.now()}`;
  try {
    await page.screenshot({ path: path.join(dir, `${stem}.png`), fullPage: true });
  } catch {}
  try {
    const html = await page.content();
    fs.writeFileSync(path.join(dir, `${stem}.html`), html);
  } catch {}
  try {
    const info = {
      branchId: branch.id,
      branchName: branch.name,
      attempt,
      url: page.url(),
      title: await page.title().catch(() => null),
      time: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(dir, `${stem}.json`), JSON.stringify(info, null, 2));
    log(`  💾 saved diagnostic → logs/diagnostic/${stem}.{png,html,json}`);
    log(`     URL: ${info.url}`);
    log(`     Title: ${info.title}`);
  } catch {}
}

async function verifySynced(branchId) {
  try {
    const res = await fetch(`${SYNC_SERVER}/api/data`, { cache: "no-store" });
    if (!res.ok) return null;
    const data = await res.json();
    const m = data.merchants?.[branchId];
    if (!m) return null;
    return { itemCount: m.items?.length || 0, lastFetched: m.lastFetched };
  } catch (err) {
    log(`  ⚠ verify failed: ${err.message}`);
    return null;
  }
}

async function processBranchWithRetry(branch) {
  let lastErr;
  for (let i = 1; i <= RETRY_ATTEMPTS; i++) {
    try {
      await processBranch(branch, i);
      return { ok: true };
    } catch (err) {
      lastErr = err;
      log(`  ✗ attempt ${i} failed: ${err.message}`);
      if (i < RETRY_ATTEMPTS) await sleep(5000 * i);
    }
  }
  return { ok: false, error: lastErr?.message };
}

async function main() {
  log(`Starting runner — sync server: ${SYNC_SERVER}, headless: ${HEADLESS}`);

  let vault;
  try {
    vault = loadVault();
  } catch (err) {
    log(`Vault error: ${err.message}`);
    log("Run: node vault-cli.js init   then  vault-cli.js add <id> <name>");
    process.exit(1);
  }

  let branches = vault.branches;
  if (branches.length === 0) {
    log("No branches in vault. Add some with: node vault-cli.js add <id> <name>");
    process.exit(1);
  }

  if (BRANCHES_LIMIT > 0) branches = branches.slice(0, BRANCHES_LIMIT);

  const startedAt = Date.now();
  let okCount = 0,
    failCount = 0;
  const failed = [];

  for (let i = 0; i < branches.length; i++) {
    const branch = branches[i];
    log(`\n[${i + 1}/${branches.length}] ${branch.name || branch.id}`);
    const result = await processBranchWithRetry(branch);
    if (result.ok) okCount++;
    else {
      failCount++;
      failed.push({ id: branch.id, error: result.error });
    }

    if (i < branches.length - 1) {
      const delay = randomDelay();
      log(`  💤 sleeping ${(delay / 1000).toFixed(0)}s…`);
      await sleep(delay);
    }
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
  log(`\nDone in ${elapsed}s — ✓ ${okCount} ok · ✗ ${failCount} failed`);
  if (failed.length > 0) {
    log("Failed branches:");
    for (const f of failed) log(`  - ${f.id}: ${f.error}`);
  }
}

main().catch((err) => {
  log(`Fatal: ${err.message}`);
  console.error(err);
  process.exit(1);
});
