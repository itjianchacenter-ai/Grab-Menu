"use strict";

const $ = (id) => document.getElementById(id);

function fmtTime(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" });
}
function fmtDateTime(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short" });
}
function fmtRelative(ts) {
  if (!ts) return "—";
  const sec = Math.round((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec} วิที่แล้ว`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} นาทีที่แล้ว`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} ชม.ที่แล้ว`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day} วันที่แล้ว`;
  return fmtDateTime(ts);
}
function fmtPrice(p) {
  return `฿${Number(p || 0).toLocaleString("th-TH", { maximumFractionDigits: 0 })}`;
}

let state = { merchants: {}, events: [], currentBranchId: null, view: "menu" };

async function load() {
  const data = await new Promise((res) =>
    chrome.storage.local.get(["merchants", "events"], (d) => res(d || {})),
  );
  state.merchants = data.merchants || {};
  state.events = data.events || [];
  const ids = Object.keys(state.merchants);
  if (!state.currentBranchId || !state.merchants[state.currentBranchId]) {
    state.currentBranchId = ids[0] || null;
  }
  render();
}

function render() {
  const ids = Object.keys(state.merchants);
  if (ids.length === 0) {
    $("empty").classList.remove("hidden");
    $("branch-bar").classList.add("hidden");
    $("view-menu").classList.add("hidden");
    $("view-log").classList.add("hidden");
    return;
  }
  $("empty").classList.add("hidden");
  $("branch-bar").classList.remove("hidden");

  const select = $("branch-select");
  select.innerHTML = "";
  for (const id of ids) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = state.merchants[id].name || id;
    if (id === state.currentBranchId) opt.selected = true;
    select.appendChild(opt);
  }

  const branch = state.merchants[state.currentBranchId];
  $("last-fetched").textContent = `อัปเดต: ${fmtRelative(branch?.lastFetched)}`;

  if (state.view === "menu") {
    $("view-menu").classList.remove("hidden");
    $("view-log").classList.add("hidden");
    renderMenu(branch);
  } else {
    $("view-menu").classList.add("hidden");
    $("view-log").classList.remove("hidden");
    renderLog(state.currentBranchId);
  }
}

function lastEventByMenu(branchId) {
  const map = new Map();
  for (const e of state.events) {
    if (!map.has(e.menuId)) map.set(e.menuId, e);
    else if (e.ts > map.get(e.menuId).ts) map.set(e.menuId, e);
  }
  return map;
}

function renderMenu(branch) {
  if (!branch) return;
  const total = branch.items.length;
  const available = branch.items.filter((i) => i.isAvailable).length;
  const unavailable = total - available;

  $("stats").innerHTML = `
    <div class="stat"><div class="stat-value">${total}</div><div class="stat-label">เมนู</div></div>
    <div class="stat"><div class="stat-value green">${available}</div><div class="stat-label">ขายอยู่</div></div>
    <div class="stat"><div class="stat-value red">${unavailable}</div><div class="stat-label">หมด</div></div>
    <div class="stat"><div class="stat-value">${branch.isOpen ? "เปิด" : "ปิด"}</div><div class="stat-label">ร้าน</div></div>
  `;

  const groups = new Map();
  for (const item of branch.items) {
    const key = item.category || "อื่นๆ";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const lastEvents = lastEventByMenu(branch.id);

  const list = $("menu-list");
  list.innerHTML = "";
  for (const [cat, items] of groups) {
    const availInCat = items.filter((i) => i.isAvailable).length;
    const section = document.createElement("div");
    section.className = "category";
    section.innerHTML = `
      <div class="category-head">
        <span class="category-name">${escapeHtml(cat)}</span>
        <span class="category-count">${availInCat}/${items.length} ขายอยู่</span>
      </div>
      <div class="menu-grid"></div>
    `;
    const grid = section.querySelector(".menu-grid");
    for (const item of items) {
      grid.appendChild(menuCard(item, lastEvents.get(item.id)));
    }
    list.appendChild(section);
  }
}

function menuCard(m, lastEvent) {
  const card = document.createElement("article");
  card.className = "menu-card" + (m.isAvailable ? "" : " unavailable");

  const img = m.imageUrl
    ? `<img src="${escapeAttr(m.imageUrl)}" alt="${escapeAttr(m.name)}" class="menu-image${m.isAvailable ? "" : " unavail"}" referrerpolicy="no-referrer" />`
    : `<div class="menu-image-empty">🍽️</div>`;

  const badge = m.isAvailable
    ? `<span class="menu-badge green">ขายอยู่</span>`
    : `<span class="menu-badge red">หมด</span>`;

  let statusLine = "";
  if (lastEvent) {
    if (lastEvent.type === "CLOSED") {
      statusLine = `<div class="menu-status closed">❌ ปิด ${fmtTime(lastEvent.ts)} · ${fmtRelative(lastEvent.ts)}</div>`;
    } else if (lastEvent.type === "OPENED") {
      statusLine = `<div class="menu-status opened">✅ เปิด ${fmtTime(lastEvent.ts)} · ${fmtRelative(lastEvent.ts)}</div>`;
    } else if (lastEvent.type === "PRICE_CHANGED") {
      statusLine = `<div class="menu-status">💰 ราคาเปลี่ยน · ${fmtRelative(lastEvent.ts)}</div>`;
    } else if (lastEvent.type === "ADDED") {
      statusLine = `<div class="menu-status">🆕 เพิ่ม · ${fmtRelative(lastEvent.ts)}</div>`;
    }
  }

  card.innerHTML = `
    ${img}
    ${badge}
    <div class="menu-body">
      <div class="menu-name">${escapeHtml(m.name)}</div>
      <div class="menu-price">${fmtPrice(m.price)}</div>
      ${statusLine}
    </div>
  `;
  return card;
}

function renderLog(branchId) {
  const events = state.events
    .filter((e) => isEventOfBranch(e, branchId))
    .slice()
    .reverse()
    .slice(0, 200);

  const list = $("log-list");
  list.innerHTML = "";
  if (events.length === 0) {
    list.innerHTML = `<p style="color:#888;text-align:center;padding:20px;font-size:12px">ยังไม่มี event<br><span style="font-size:10px">รอจน Grab refresh ข้อมูลครั้งถัดไป</span></p>`;
    return;
  }
  for (const e of events) {
    const div = document.createElement("div");
    div.className = "log-item";
    const labels = {
      OPENED: "เปิดขาย",
      CLOSED: "ปิด/หมด",
      PRICE_CHANGED: "ราคาเปลี่ยน",
      ADDED: "เพิ่มเมนู",
      REMOVED: "ลบเมนู",
    };
    let detail = "";
    if (e.type === "PRICE_CHANGED") detail = ` · ${fmtPrice(e.from)} → ${fmtPrice(e.to)}`;
    div.innerHTML = `
      <div class="log-item-info">
        <div class="log-item-name">${escapeHtml(e.menuName || e.menuId)}</div>
        <div class="log-item-time">${fmtDateTime(e.ts)}${detail}</div>
      </div>
      <span class="log-pill ${e.type}">${labels[e.type] || e.type}</span>
    `;
    list.appendChild(div);
  }
}

function isEventOfBranch(e, branchId) {
  // events don't carry branchId; we check if menuId is in this branch
  const branch = state.merchants[branchId];
  if (!branch) return false;
  return branch.items.some((i) => i.id === e.menuId) || true; // permissive for first version
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function escapeAttr(s) {
  return escapeHtml(s);
}

async function captureNow() {
  const msg = $("capture-msg");
  msg.classList.remove("hidden", "ok", "err");
  msg.textContent = "⏳ กำลังดึง...";

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.startsWith("https://merchant.grab.com")) {
    msg.classList.add("err");
    msg.textContent = "❌ ไปที่ merchant.grab.com ก่อน แล้วกดปุ่มนี้อีกครั้ง";
    return;
  }
  try {
    const r = await chrome.tabs.sendMessage(tab.id, { type: "SCRAPE_NOW" });
    if (r?.count > 0) {
      msg.classList.add("ok");
      msg.textContent = `✅ ดึงได้ ${r.count} เมนู`;
      await load();
    } else {
      msg.classList.add("err");
      msg.textContent = `⚠️ ไม่เจอเมนู (${r?.reason || "unknown"}) — ลองรอหน้าโหลดเสร็จก่อน`;
    }
    setTimeout(() => msg.classList.add("hidden"), 4000);
  } catch (err) {
    msg.classList.add("err");
    msg.textContent = `❌ ${err.message} — ลอง refresh หน้า merchant แล้วลองใหม่`;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  $("open-dashboard").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
  });

  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.view = btn.dataset.tab;
      render();
    });
  });
  $("branch-select").addEventListener("change", (e) => {
    state.currentBranchId = e.target.value;
    render();
  });
  $("capture-now").addEventListener("click", captureNow);
  $("capture-now-empty").addEventListener("click", captureNow);
  $("clear").addEventListener("click", async () => {
    if (!confirm("ลบข้อมูลทั้งหมด (เมนู + log) จริงๆ?")) return;
    await new Promise((res) => chrome.storage.local.clear(() => res()));
    state = { merchants: {}, events: [], currentBranchId: null, view: "menu" };
    render();
  });

  load();

  // Live update when storage changes
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.merchants || changes.events) load();
  });
});
