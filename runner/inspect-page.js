#!/usr/bin/env node
"use strict";
const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.connectOverCDP("http://localhost:9222");
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes("merchant.grab.com")) || ctx.pages()[0];
  console.log("URL:", page.url());
  const body = await page.evaluate(() => {
    return {
      title: document.title,
      h1s: [...document.querySelectorAll("h1,h2,h3")].slice(0, 10).map((e) => e.textContent.trim()),
      errors: [...document.querySelectorAll('[class*="error"], [class*="Error"], [class*="empty"]')].slice(0, 5).map((e) => e.textContent.trim().slice(0, 100)),
      url: location.href,
      bodyTextLen: (document.body?.innerText || "").length,
      bodyText: (document.body?.innerText || "").slice(0, 300),
    };
  });
  console.log(JSON.stringify(body, null, 2));
  await browser.close();
})();
