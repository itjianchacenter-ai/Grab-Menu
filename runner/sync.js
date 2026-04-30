#!/usr/bin/env node
"use strict";
/**
 * Sync test — fetch one branch via HTTP API, print result.
 *
 * Usage:
 *   node sync.js <account>                # test all candidate URLs for first branch in vault
 *   node sync.js <account> <merchantId>   # test specific branch
 */

require("dotenv").config({ path: require("path").resolve(__dirname, ".env") });

const { GrabApiClient } = require("./api-client");
const { load: loadVault } = require("./vault");

async function main() {
  const account = process.argv[2];
  const branchId = process.argv[3];
  if (!account) {
    console.error("Usage: node sync.js <account> [merchantId]");
    process.exit(1);
  }

  const client = new GrabApiClient(account);
  console.log(`Account: ${account}`);
  console.log(`MerchantGroupId: ${client.accountInfo.merchantGroupId || "(not captured)"}`);
  console.log(`Cookies: ${client.cookies.length}\n`);

  // Pick branch
  let id = branchId;
  if (!id) {
    const v = loadVault();
    const active = v.branches.filter((b) => !/\[CLOSE\s*(UP|DOWN)\]/i.test(b.name || ""));
    id = active[0]?.id;
    if (!id) {
      console.error("No active branches in vault");
      process.exit(1);
    }
  }
  console.log(`Testing branch: ${id}`);
  console.log(`─`.repeat(70));

  // Try per-merchant endpoints
  const results = await client.fetchMerchantData(id);
  for (const r of results) {
    if (r.error) {
      console.log(`\n✗ ${r.url}\n  ERROR: ${r.error}`);
      continue;
    }
    const looksLikeJson = r.json !== null;
    const hasMerchantKey = looksLikeJson && (r.json.merchant || r.json.ID || r.json.id);
    const hasMenuKey = looksLikeJson && (r.json.categories || r.json.items || r.json.menu);
    console.log(`\n${r.status === 200 ? "✓" : "✗"} ${r.url}`);
    console.log(`  status: ${r.status}, length: ${r.length}b, json: ${looksLikeJson}`);
    if (hasMerchantKey || hasMenuKey) {
      console.log(`  ⭐ contains: ${hasMerchantKey ? "merchant " : ""}${hasMenuKey ? "menu" : ""}`);
      if (looksLikeJson) {
        const keys = Array.isArray(r.json)
          ? `[Array ${r.json.length}]`
          : Object.keys(r.json).slice(0, 8).join(",");
        console.log(`  top keys: ${keys}`);
      }
    } else {
      console.log(`  sample: ${r.sample.replace(/\s+/g, " ").slice(0, 150)}`);
    }
  }

  // Try session menu (current branch in session)
  console.log(`\n─`.repeat(70));
  console.log(`Session menu (no Referer):`);
  const sm = await client.fetchSessionMenu();
  console.log(`  status: ${sm.status}, length: ${sm.body.length}b`);
  let baseFingerprint = null;
  if (sm.status === 200) {
    try {
      const j = JSON.parse(sm.body);
      console.log(`  ⭐ ${j.categories?.length || 0} categories`);
      // Fingerprint: first category name + count of items in first category
      const firstCat = j.categories?.[0];
      baseFingerprint = `${firstCat?.categoryName || "?"} | ${firstCat?.items?.length || 0} items`;
      console.log(`  fingerprint: ${baseFingerprint}`);
    } catch {}
  }

  // Test Referer-based branch switching
  console.log(`\n─`.repeat(70));
  console.log(`Session menu WITH Referer=${id}:`);
  const sm2 = await client.fetchSessionMenu(id);
  console.log(`  status: ${sm2.status}, length: ${sm2.body.length}b`);
  if (sm2.status === 200) {
    try {
      const j = JSON.parse(sm2.body);
      console.log(`  ⭐ ${j.categories?.length || 0} categories`);
      const firstCat = j.categories?.[0];
      const fp = `${firstCat?.categoryName || "?"} | ${firstCat?.items?.length || 0} items`;
      console.log(`  fingerprint: ${fp}`);
      if (baseFingerprint && fp !== baseFingerprint) {
        console.log(`\n🎯 DIFFERENT! Referer header switches branch — we have a solution!`);
      } else {
        console.log(`\n⚠ Same fingerprint — Referer doesn't switch. Need different mechanism.`);
      }
    } catch {}
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
