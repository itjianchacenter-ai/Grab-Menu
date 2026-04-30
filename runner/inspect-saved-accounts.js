#!/usr/bin/env node
"use strict";
const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.connectOverCDP("http://localhost:9222");
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes("grab.com")) || ctx.pages()[0];
  console.log("URL:", page.url());

  const info = await page.evaluate(() => {
    const els = [...document.querySelectorAll("*")].filter((e) => {
      const t = (e.textContent || "").trim();
      return t.includes("ลงชื่อเข้าใช้ด้วยบัญชีอื่น") || t === "ลบบัญชีออก" || t === "ต่อไป";
    });
    return els.slice(0, 20).map((e) => ({
      tag: e.tagName,
      role: e.getAttribute("role"),
      type: e.getAttribute("type"),
      cls: (e.className?.toString() || "").slice(0, 80),
      text: (e.textContent || "").trim().slice(0, 60),
      childCount: e.children.length,
    }));
  });
  console.log("\n--- elements with target text ---");
  for (const e of info) console.log(`  ${e.tag} role=${e.role} cls=${e.cls} children=${e.childCount} text="${e.text}"`);

  await browser.close();
})();
