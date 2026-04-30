#!/usr/bin/env node
"use strict";
/**
 * Auth tool — เปิด Chrome ให้ user login → extract cookies → save encrypted
 *
 * ใช้:  node auth.js <account-name>
 *   เช่น: node auth.js siamparagon
 *
 * ขั้นตอน:
 *   1. เปิด Chrome (real, headed)
 *   2. ไปที่ merchant.grab.com
 *   3. user login (manual)
 *   4. กด Enter ใน Terminal — ดึง cookies + เก็บเข้า cookies/<account>.enc
 */

require("dotenv").config({ path: require("path").resolve(__dirname, ".env") });

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { chromium } = require("playwright");
const cookies = require("./cookies");

const account = process.argv[2];
if (!account) {
  console.error("Usage: node auth.js <account-name>");
  console.error("       e.g. node auth.js siamparagon");
  process.exit(1);
}

function ask(q) {
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => {
      rl.close();
      res(a.trim());
    });
  });
}

async function main() {
  const profileDir = path.resolve(__dirname, "auth-profiles", account);
  fs.mkdirSync(profileDir, { recursive: true });

  console.log(`\n🔐 Auth flow for account: ${account}`);
  console.log(`   Profile dir: ${profileDir}\n`);

  const launchOpts = {
    headless: false,
    args: ["--no-first-run", "--no-default-browser-check"],
    viewport: { width: 1280, height: 800 },
  };
  let context;
  try {
    launchOpts.channel = "chrome";
    context = await chromium.launchPersistentContext(profileDir, launchOpts);
  } catch {
    delete launchOpts.channel;
    context = await chromium.launchPersistentContext(profileDir, launchOpts);
  }

  const page = context.pages()[0] || (await context.newPage());
  await page.goto("https://merchant.grab.com/portal").catch(() => {});

  console.log("👉 ใน Chrome ที่เปิดมา:");
  console.log("   1. Login บัญชีของคุณ");
  console.log("   2. รอจนเห็นหน้า dashboard / menu");
  console.log("   3. กลับมา Terminal นี้ → กด Enter\n");

  await ask("พร้อม? Enter: ");

  // Extract cookies
  const allCookies = await context.cookies();
  console.log(`\n📋 Cookies found: ${allCookies.length}`);
  const grabCookies = allCookies.filter((c) =>
    /grab\.com|grabtaxi\.com/.test(c.domain),
  );
  console.log(`   • grab.com cookies: ${grabCookies.length}`);

  // Try to extract merchantGroupId from page
  let merchantGroupId = null;
  let displayName = null;
  try {
    const info = await page.evaluate(() => {
      // Look for merchant_group_id in storage / cookies / page
      const allStorage = JSON.stringify(localStorage) + " " + JSON.stringify(sessionStorage);
      const m = allStorage.match(/THMG\d+/);
      const groupId = m ? m[0] : null;
      // Try to find display name
      const nameEl = document.querySelector('[class*="user"], [class*="account"], [class*="profile"]');
      const name = nameEl?.textContent?.trim().slice(0, 100) || null;
      return { groupId, name };
    });
    merchantGroupId = info.groupId;
    displayName = info.name;
  } catch (_) {}

  if (merchantGroupId) console.log(`   • merchant_group_id: ${merchantGroupId}`);

  await context.close();

  // Save encrypted
  const filePath = cookies.save(account, grabCookies, { merchantGroupId, displayName });
  console.log(`\n✓ Saved to: ${filePath}`);
  console.log(`  ${grabCookies.length} cookies encrypted with VAULT_PASSWORD`);
  console.log(`\nNext: node sync.js ${account}    # test fetch via HTTP API`);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
