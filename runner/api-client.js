"use strict";
/**
 * HTTP API client for Grab Merchant — uses cookies extracted by auth.js
 *
 * Endpoints we know:
 *   GET https://portal.grab.com/foodtroy/v2/TH/merchants/<id>     (merchant info)
 *   GET https://api.grab.com/food/merchant/v2/menu                (menu — session based!)
 *
 * For session-based menu: try multiple URL patterns, plus per-merchant variants.
 */

const cookies = require("./cookies");

const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "th-TH,th;q=0.9,en;q=0.8",
  Origin: "https://merchant.grab.com",
  Referer: "https://merchant.grab.com/",
};

class GrabApiClient {
  constructor(account) {
    const data = cookies.load(account);
    if (!data) throw new Error(`No cookies for account "${account}". Run: node auth.js ${account}`);
    this.account = account;
    this.cookies = data.cookies;
    this.accountInfo = data.accountInfo || {};
  }

  cookieHeader(domain = "merchant.grab.com") {
    return cookies.toCookieHeader(this.cookies, domain);
  }

  async fetch(url, opts = {}) {
    const u = new URL(url);
    const headers = {
      ...DEFAULT_HEADERS,
      Cookie: this.cookieHeader(u.hostname),
      ...(opts.headers || {}),
    };
    const res = await fetch(url, { ...opts, headers });
    return res;
  }

  /**
   * Try several URL patterns for fetching a specific branch's menu/info.
   * Returns the first response that looks like merchant data.
   */
  async fetchMerchantData(merchantId) {
    const candidates = [
      `https://portal.grab.com/foodtroy/v2/TH/merchants/${merchantId}`,
      `https://portal.grab.com/foodtroy/v2/TH/merchants/${merchantId}/menu`,
      `https://api.grab.com/foodweb/v2/merchants/${merchantId}`,
    ];
    const results = [];
    for (const url of candidates) {
      try {
        const res = await this.fetch(url);
        const status = res.status;
        const text = await res.text();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch (_) {}
        results.push({ url, status, length: text.length, sample: text.slice(0, 200), json });
      } catch (err) {
        results.push({ url, error: err.message });
      }
    }
    return results;
  }

  /**
   * Try the session-based menu endpoint.
   * Returns full menu of whatever branch is currently selected in session.
   *
   * Optional: pass a merchantId to set Referer header to that branch's menu page,
   * which MAY trick Grab into returning that branch's data.
   */
  async fetchSessionMenu(merchantId = null) {
    const url = "https://api.grab.com/food/merchant/v2/menu";
    const headers = {};
    if (merchantId) {
      headers.Referer = `https://merchant.grab.com/food/menu/${merchantId}/menuOverview`;
      // Some APIs use these custom headers
      headers["X-Merchant-Id"] = merchantId;
      headers["X-Selected-Merchant-Id"] = merchantId;
    }
    const res = await this.fetch(url, { headers });
    return { status: res.status, body: await res.text() };
  }
}

module.exports = { GrabApiClient };
