#!/usr/bin/env node
"use strict";
/**
 * Auto-sync — ใช้ Playwright (CDP attach) intercept network responses ของ Grab
 * ไม่ใช้ extension, ไม่ต้อง switch session
 *
 * Logic:
 *   1. CDP attach ไป Chrome 9222 (real Chrome, ไม่ใช่ Playwright launched)
 *   2. สำหรับแต่ละสาขา:
 *        - navigate ไป /food/menu/<id>/menuOverview
 *        - listen for /food/merchant/v2/menu response
 *        - parse → POST localhost server
 *   3. Loop ทุกสาขา
 *
 * Usage:
 *   node auto-sync.js               # ทุกสาขาที่ active
 *   node auto-sync.js 3-XXX 3-YYY   # specific
 */

require("dotenv").config({ path: require("path").resolve(__dirname, ".env") });

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { load: loadVault } = require("./vault");

const CDP_URL = process.env.CDP_URL || "http://localhost:9222";
const SYNC_SERVER = process.env.SYNC_SERVER || "http://localhost:8765";
const SYNC_TOKEN = process.env.SYNC_TOKEN || "";
const DELAY_MIN = Number(process.env.DELAY_MIN || 5);
const DELAY_MAX = Number(process.env.DELAY_MAX || 15);
const WAIT_MAX = Number(process.env.WAIT_MAX || 25);

const LOGS_DIR = path.resolve(__dirname, "logs");
fs.mkdirSync(LOGS_DIR, { recursive: true });
const logFile = path.join(LOGS_DIR, `auto-sync-${new Date().toISOString().slice(0, 10)}.log`);
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(String).join(" ")}`;
  console.log(line);
  try {
    fs.appendFileSync(logFile, line + "\n");
  } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomDelay = () => Math.round((DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN)) * 1000);

function normalizeMenu(json, branchId, sourceUrl, merchantInfo) {
  const items = [];
  const seen = new Set();

  for (const cat of json.categories || []) {
    if (!Array.isArray(cat.items)) continue;
    const catName = cat.categoryName || cat.name || null;
    const catAvailable = cat.availableStatus === undefined ? true : cat.availableStatus === 1;
    for (const it of cat.items) {
      const id = it.itemID || it.itemId || it.id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      // priceDisplay like "฿9,999.00"
      let price = 0;
      if (typeof it.priceDisplay === "string") {
        const m = it.priceDisplay.match(/[\d,]+(?:\.\d+)?/);
        if (m) price = parseFloat(m[0].replace(/,/g, "")) || 0;
      } else if (it.price != null) {
        price = Number(it.price);
      }
      const isAvailable = catAvailable && (it.availableStatus === undefined ? true : it.availableStatus === 1);
      items.push({
        id,
        name: it.itemName || it.name || id,
        category: catName,
        description: it.description || null,
        price,
        imageUrl: it.imageURL || it.imageUrl || null,
        isAvailable,
      });
    }
  }

  return {
    id: branchId,
    name: merchantInfo?.name || `Merchant ${branchId}`,
    address: merchantInfo?.address?.address || merchantInfo?.address || null,
    isOpen: true,
    openHours: merchantInfo?.openingHours ? JSON.stringify(merchantInfo.openingHours) : null,
    items,
    lastFetched: Date.now(),
    sourceUrl,
    sources: ["http"],
  };
}

async function captureBranch(page, branchId) {
  const url = `https://merchant.grab.com/food/menu/${branchId}/menuOverview`;
  let menuJson = null;
  let merchantInfo = null;

  // Set up response listener BEFORE navigation
  const onResponse = async (response) => {
    try {
      const u = response.url();
      if (u.includes("api.grab.com/food/merchant/v2/menu")) {
        const text = await response.text();
        try {
          const j = JSON.parse(text);
          if (Array.isArray(j.categories)) menuJson = j;
        } catch {}
      }
      if (u.includes("portal.grab.com/foodtroy/v2/TH/merchants/")) {
        const text = await response.text();
        try {
          const j = JSON.parse(text);
          if (j.merchant) merchantInfo = j.merchant;
        } catch {}
      }
    } catch {}
  };
  page.on("response", onResponse);

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  } catch (err) {
    page.off("response", onResponse);
    return { ok: false, error: `nav: ${err.message}` };
  }

  // Wait for menu JSON to arrive (poll up to WAIT_MAX seconds)
  const start = Date.now();
  while (!menuJson && Date.now() - start < WAIT_MAX * 1000) {
    await sleep(500);
  }
  page.off("response", onResponse);

  if (!menuJson) return { ok: false, error: "no-menu-response" };

  const finalUrl = page.url();
  if (!finalUrl.includes(branchId)) {
    return { ok: false, error: `redirected to ${finalUrl}` };
  }

  // Build snapshot + POST to server
  const snapshot = normalizeMenu(menuJson, branchId, finalUrl, merchantInfo);
  try {
    const headers = { "Content-Type": "application/json" };
    if (SYNC_TOKEN) headers["X-Sync-Token"] = SYNC_TOKEN;
    const r = await fetch(`${SYNC_SERVER}/api/sync`, {
      method: "POST",
      headers,
      body: JSON.stringify({ merchants: { [branchId]: snapshot }, events: [] }),
    });
    const j = await r.json();
    if (!j.ok) return { ok: false, error: `server: ${j.error}` };
  } catch (err) {
    return { ok: false, error: `server: ${err.message}` };
  }

  return { ok: true, items: snapshot.items.length, name: snapshot.name };
}

async function main() {
  log(`Connecting to Chrome at ${CDP_URL}`);
  const browser = await chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0];
  if (!ctx) {
    log("✗ No context");
    process.exit(1);
  }

  const pages = ctx.pages();
  const page = pages.find((p) => p.url().includes("merchant.grab.com")) || pages[0] || (await ctx.newPage());

  const args = process.argv.slice(2);
  let branchIds;
  if (args.length > 0) {
    branchIds = args;
  } else {
    const v = loadVault();
    branchIds = v.branches
      .filter((b) => !/\[CLOSE\s*(UP|DOWN)\]/i.test(b.name || ""))
      .map((b) => b.id);
  }

  log(`Processing ${branchIds.length} branches`);

  const results = [];
  for (let i = 0; i < branchIds.length; i++) {
    const id = branchIds[i];
    log(`\n[${i + 1}/${branchIds.length}] ${id}`);
    const r = await captureBranch(page, id).catch((err) => ({ ok: false, error: err.message }));
    if (r.ok) log(`  ✓ ${r.name?.slice(0, 50)} — ${r.items} items`);
    else log(`  ✗ ${r.error}`);
    results.push({ id, ...r });

    if (i < branchIds.length - 1) {
      const d = randomDelay();
      log(`  💤 sleep ${(d / 1000).toFixed(0)}s`);
      await sleep(d);
    }
  }

  await browser.close();
  const ok = results.filter((r) => r.ok).length;
  log(`\n═══ Done ═══`);
  log(`✓ ${ok}/${results.length} synced`);
}

main().catch((err) => {
  log(`Fatal: ${err.message}`);
  process.exit(1);
});
