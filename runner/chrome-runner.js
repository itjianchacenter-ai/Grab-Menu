#!/usr/bin/env node
"use strict";
/**
 * Chrome Runner — เปิด URL ใน Google Chrome ปกติของคุณ (ไม่ใช่ Playwright)
 * แล้วรอให้ extension ดักเมนู → ปิด tab → next branch.
 *
 * ข้อดี: Chrome ปกติไม่มี automation banner — Grab ไม่ block
 * ข้อจำกัด: ต้อง login บัญชีของสาขาที่ต้องการดึงไว้ใน Chrome (1 profile = 1 บัญชี)
 *
 * Usage:
 *   node chrome-runner.js                 # รันทุกสาขาที่ active ใน vault
 *   BRANCHES_LIMIT=1 node chrome-runner.js
 *   node chrome-runner.js 3-C6LELZAYNNVHGA # รันสาขาเดียว
 */

require("dotenv").config({ path: require("path").resolve(__dirname, ".env") });

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { load: loadVault } = require("./vault");

const SYNC_SERVER = process.env.SYNC_SERVER || "http://localhost:8765";
const DELAY_MIN = Number(process.env.DELAY_MIN || 10);
const DELAY_MAX = Number(process.env.DELAY_MAX || 30);
const BRANCHES_LIMIT = Number(process.env.BRANCHES_LIMIT || 0);
const WAIT_AFTER_OPEN = Number(process.env.WAIT_AFTER_OPEN || 15);

const LOGS_DIR = path.resolve(__dirname, "logs");
fs.mkdirSync(LOGS_DIR, { recursive: true });

const logFile = path.join(LOGS_DIR, `chrome-runner-${new Date().toISOString().slice(0, 10)}.log`);
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(String).join(" ")}`;
  console.log(line);
  try {
    fs.appendFileSync(logFile, line + "\n");
  } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomDelay = () => Math.round((DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN)) * 1000);

function osascript(script) {
  return execSync("osascript -", { input: script, encoding: "utf8" }).toString().trim();
}

function ensureChrome() {
  try {
    osascript('tell application "Google Chrome" to activate');
  } catch {
    execSync(`open -na "Google Chrome"`);
  }
}

function openTab(url) {
  const script = `
tell application "Google Chrome"
  activate
  if (count of windows) is 0 then make new window
  set newTab to make new tab at end of tabs of window 1 with properties {URL:"${url}"}
  return (id of newTab) as string
end tell`;
  return osascript(script);
}

function closeTabById(tabId) {
  const script = `
tell application "Google Chrome"
  repeat with w in windows
    set tabIndex to 1
    repeat with t in tabs of w
      if (id of t as string) is "${tabId}" then
        close tab tabIndex of w
        return "ok"
      end if
      set tabIndex to tabIndex + 1
    end repeat
  end repeat
  return "not-found"
end tell`;
  return osascript(script);
}

async function verifySynced(branchId, beforeTs) {
  try {
    const res = await fetch(`${SYNC_SERVER}/api/data`, { cache: "no-store" });
    if (!res.ok) return null;
    const data = await res.json();
    const m = data.merchants?.[branchId];
    if (!m) return null;
    // Confirm it was updated AFTER we opened the tab
    if (beforeTs && m.lastFetched && m.lastFetched < beforeTs) return null;
    return { itemCount: m.items?.length || 0, lastFetched: m.lastFetched };
  } catch (err) {
    return null;
  }
}

async function processBranch(branch) {
  const url = `https://merchant.grab.com/food/menu/${branch.id}/menuOverview`;
  const beforeTs = Date.now();

  let tabId = null;
  try {
    tabId = openTab(url);
    log(`  🌐 opened tab #${tabId}`);
  } catch (err) {
    log(`  ✗ failed to open tab: ${err.message}`);
    return { ok: false, error: "open-tab-failed" };
  }

  log(`  ⏳ waiting ${WAIT_AFTER_OPEN}s for extension capture…`);
  await sleep(WAIT_AFTER_OPEN * 1000);

  const verified = await verifySynced(branch.id, beforeTs);

  if (tabId) {
    try {
      closeTabById(tabId);
      log(`  🚪 closed tab`);
    } catch (err) {
      log(`  ⚠ couldn't close tab: ${err.message}`);
    }
  }

  if (verified) {
    log(`  ✓ ${branch.name} synced (${verified.itemCount} items)`);
    return { ok: true };
  } else {
    log(`  ⚠ no fresh data — likely not logged in for this branch`);
    return { ok: false, error: "no-data (login needed)" };
  }
}

async function main() {
  log(`Chrome Runner — sync server: ${SYNC_SERVER}`);

  let vault;
  try {
    vault = loadVault();
  } catch (err) {
    log(`Vault error: ${err.message}`);
    process.exit(1);
  }

  const targetId = process.argv[2];
  let branches = vault.branches.filter((b) => !/\[CLOSE\s*(UP|DOWN)\]/i.test(b.name || ""));
  if (targetId) {
    branches = branches.filter((b) => b.id === targetId);
    if (branches.length === 0) {
      log(`Branch ${targetId} not in vault`);
      process.exit(1);
    }
  } else if (BRANCHES_LIMIT > 0) {
    branches = branches.slice(0, BRANCHES_LIMIT);
  }

  log(`Processing ${branches.length} branches`);
  ensureChrome();
  await sleep(1500);

  const results = [];
  for (let i = 0; i < branches.length; i++) {
    const b = branches[i];
    log(`\n[${i + 1}/${branches.length}] ${b.name || b.id}`);
    const r = await processBranch(b);
    results.push({ branch: b, ...r });

    if (i < branches.length - 1) {
      const d = randomDelay();
      log(`  💤 sleep ${(d / 1000).toFixed(0)}s`);
      await sleep(d);
    }
  }

  const ok = results.filter((r) => r.ok).length;
  log(`\nDone — ✓ ${ok}/${results.length} synced`);

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    log("\nFailed (need login):");
    for (const f of failed) log(`  - ${f.branch.id} ${f.branch.name?.slice(0, 50) || ""}`);
  }
}

main().catch((err) => {
  log(`Fatal: ${err.message}`);
  process.exit(1);
});
