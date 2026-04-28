// Content script (ISOLATED world).
// - Receives postMessages from inject.js (MAIN world) carrying captured API responses
// - Recognises Grab-specific endpoints (merchant info + menu) and saves to chrome.storage
// - Falls back to DOM scraping if API capture doesn't yield data

(function () {
  "use strict";
  const TAG = "[grab-menu/content v0.3.0]";
  const LOCAL_SYNC_URL = "http://localhost:8765/api/sync";
  console.log(TAG, "🟢 LOADED", "readyState:", document.readyState, "url:", location.pathname);

  let syncTimer = null;
  function scheduleSync() {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(syncToLocal, 1500);
  }
  async function syncToLocal() {
    try {
      const data = await getStorage();
      const body = JSON.stringify({ merchants: data.merchants || {}, events: data.events || [] });
      const r = await fetch(LOCAL_SYNC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (r.ok) console.log(TAG, "🔄 synced to localhost");
    } catch (_) {
      // server not running — that's fine, ignore silently
    }
  }

  // ---------- API capture ----------
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__grabMenu !== true) return;
    if (!data.body) return;
    handleApiCapture(data.body, data.url || "", data.ts || Date.now()).catch((err) =>
      console.warn(TAG, "handleApiCapture failed", err),
    );
  });

  async function handleApiCapture(rawText, url, ts) {
    let json;
    try {
      json = JSON.parse(rawText);
    } catch {
      return;
    }
    const topKeys = Array.isArray(json)
      ? `[Array ${json.length}]`
      : Object.keys(json).slice(0, 8).join(",");
    console.log(TAG, "📦", url.slice(-70), `${rawText.length}b · keys:`, topKeys);

    const merchantId = getMerchantIdFromUrl();

    // 1) Grab merchant info response
    if (json.merchant?.ID) {
      await saveMerchantInfo(json.merchant, ts, url);
      return;
    }

    // 2) Grab menu response (categories at top level)
    if (Array.isArray(json.categories) && json.categories.length > 0 && merchantId) {
      const items = parseGrabCategories(json.categories);
      console.log(TAG, `🍽️ parsed ${items.length} items from categories`);
      if (items.length > 0) {
        await saveMenuSnapshot(merchantId, items, ts, url);
        return;
      }
    }

    // 3) Fallback: nested categories somewhere
    const nestedCats = findNestedCategories(json);
    if (nestedCats && merchantId) {
      const items = parseGrabCategories(nestedCats);
      if (items.length > 0) {
        console.log(TAG, `🍽️ parsed ${items.length} items from nested categories`);
        await saveMenuSnapshot(merchantId, items, ts, url);
        return;
      }
    }

    console.log(TAG, "skipped — not a recognized merchant/menu shape");
  }

  function findNestedCategories(json) {
    let found = null;
    const visit = (n, depth = 0) => {
      if (depth > 8 || !n || typeof n !== "object" || found) return;
      if (Array.isArray(n)) {
        for (const v of n) visit(v, depth + 1);
        return;
      }
      if (Array.isArray(n.categories) && n.categories.some((c) => Array.isArray(c?.items))) {
        found = n.categories;
        return;
      }
      for (const v of Object.values(n)) visit(v, depth + 1);
    };
    visit(json);
    return found;
  }

  // ---------- Grab-specific parsers ----------
  function parsePrice(it) {
    // priceDisplay like "฿9,999.00"
    if (typeof it.priceDisplay === "string") {
      const m = it.priceDisplay.match(/[\d,]+(?:\.\d+)?/);
      if (m) return parseFloat(m[0].replace(/,/g, "")) || 0;
    }
    if (it.priceV2?.amountInMinor != null) return it.priceV2.amountInMinor / 100;
    if (it.pricing?.priceInMinor != null) return it.pricing.priceInMinor / 100;
    if (typeof it.priceInMinor === "number") return it.priceInMinor / 100;
    if (typeof it.price === "number") return it.price;
    if (typeof it.amount === "number") return it.amount;
    return 0;
  }

  function parseAvailable(it) {
    // Grab merchant API uses availableStatus: 1 = available, 0 = unavailable
    if (typeof it.availableStatus === "number") return it.availableStatus === 1;
    if (typeof it.availableStatus === "boolean") return it.availableStatus;
    if (typeof it.available === "boolean") return it.available;
    if (typeof it.isAvailable === "boolean") return it.isAvailable;
    if (typeof it.soldOut === "boolean") return !it.soldOut;
    if (typeof it.isPaused === "boolean") return !it.isPaused;
    return true;
  }

  function parseGrabCategories(categories) {
    const items = [];
    const seen = new Set();
    for (const cat of categories) {
      if (!Array.isArray(cat?.items)) continue;
      const catName = cat.categoryName || cat.name || null;
      const catAvailable = parseAvailable(cat);
      for (const it of cat.items) {
        const id = it.itemID || it.itemId || it.id || it.ID;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        items.push({
          id,
          name: it.itemName || it.name || it.title || id,
          category: catName,
          description: it.description || it.desc || null,
          price: parsePrice(it),
          imageUrl: it.imageURL || it.imageUrl || it.imgHref || it.photoHref || null,
          isAvailable: catAvailable && parseAvailable(it),
        });
      }
    }
    return items;
  }

  // ---------- Save handlers ----------
  async function saveMerchantInfo(m, ts, sourceUrl) {
    const stored = await getStorage();
    const merchants = { ...(stored.merchants || {}) };
    const existing = merchants[m.ID] || { items: [] };

    let address = null;
    if (typeof m.address === "string") address = m.address;
    else if (m.address) address = m.address.address || m.address.city || m.address.fullAddress || null;
    if (!address && typeof m.merchantAddress === "string") address = m.merchantAddress;

    merchants[m.ID] = {
      ...existing,
      id: m.ID,
      name: m.name || existing.name || "Unknown",
      address: address ?? existing.address ?? null,
      openHours: m.openingHours ? JSON.stringify(m.openingHours) : existing.openHours ?? null,
      phone: m.mobileNumber || existing.phone || null,
      lat: m.latitude ?? existing.lat ?? null,
      lng: m.longitude ?? existing.lng ?? null,
      isOpen: existing.isOpen ?? true,
      items: existing.items || [],
      lastFetched: ts,
      sourceUrl,
      sources: dedupeArr([...(existing.sources || []), "merchant-info"]),
    };

    await setStorage({ merchants });
    console.log(TAG, `✅ saved merchant info: ${m.name}`);
    scheduleSync();
  }

  async function saveMenuSnapshot(merchantId, items, ts, sourceUrl) {
    const stored = await getStorage();
    const merchants = { ...(stored.merchants || {}) };
    const existing = merchants[merchantId] || { items: [] };

    const events = computeEvents(existing.items || [], items, ts);

    merchants[merchantId] = {
      ...existing,
      id: merchantId,
      name: existing.name || `Merchant ${merchantId}`,
      items,
      lastFetched: ts,
      sourceUrl,
      sources: dedupeArr([...(existing.sources || []), "menu-api"]),
    };

    const eventLog = [...(stored.events || []), ...events];
    if (eventLog.length > 1000) eventLog.splice(0, eventLog.length - 1000);

    await setStorage({ merchants, events: eventLog });
    console.log(TAG, `✅ saved menu: ${items.length} items, +${events.length} events`);
    scheduleSync();
  }

  function dedupeArr(a) {
    return [...new Set(a)];
  }

  function getMerchantIdFromUrl() {
    const m = location.pathname.match(/\b(\d+-[A-Z0-9]{10,})/);
    return m ? m[1] : null;
  }

  // ---------- popup messaging ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "SCRAPE_NOW") {
      const merchantId = getMerchantIdFromUrl();
      sendResponse({
        count: 0,
        reason: merchantId
          ? "manual-scrape-skipped (rely on auto-capture from Grab API)"
          : "no-merchant-id-in-url",
      });
      return false;
    }
  });

  // ---------- storage ----------
  function getStorage() {
    return new Promise((resolve) =>
      chrome.storage.local.get(["merchants", "events", "rawCaptures"], (data) => resolve(data || {})),
    );
  }
  function setStorage(obj) {
    return new Promise((resolve) => chrome.storage.local.set(obj, () => resolve()));
  }

  // ---------- diff ----------
  function computeEvents(prevItems, nextItems, ts) {
    const prevMap = new Map(prevItems.map((i) => [i.id, i]));
    const nextMap = new Map(nextItems.map((i) => [i.id, i]));
    const events = [];
    for (const it of nextItems) {
      const prev = prevMap.get(it.id);
      if (!prev) {
        events.push({ ts, menuId: it.id, menuName: it.name, type: "ADDED", to: it.isAvailable });
        continue;
      }
      if (prev.isAvailable !== it.isAvailable) {
        events.push({
          ts,
          menuId: it.id,
          menuName: it.name,
          type: it.isAvailable ? "OPENED" : "CLOSED",
          from: prev.isAvailable,
          to: it.isAvailable,
        });
      }
      if (Math.abs((prev.price || 0) - (it.price || 0)) > 0.001) {
        events.push({
          ts,
          menuId: it.id,
          menuName: it.name,
          type: "PRICE_CHANGED",
          from: prev.price,
          to: it.price,
        });
      }
    }
    for (const it of prevItems) {
      if (!nextMap.has(it.id)) {
        events.push({ ts, menuId: it.id, menuName: it.name, type: "REMOVED", from: it.isAvailable });
      }
    }
    return events;
  }
})();
