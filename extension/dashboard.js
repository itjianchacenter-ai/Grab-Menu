"use strict";

const $ = (id) => document.getElementById(id);

// ========== Formatters ==========
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
  return `฿${Number(p || 0).toLocaleString("th-TH", { maximumFractionDigits: 2 })}`;
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}
function shortBranchName(name) {
  return (name || "?").replace(/^.+?\)\s*-\s*/, "").replace(/^.+?-\s*/, "").trim().slice(0, 50);
}

// ========== Master branches ==========
const MASTER_IDS = new Set([
  "3-C6LELZAYNNVHGA", // Dragon Town
  "3-C72TAKABAKE1V2", // Groove @Central World
  "3-C4N3JLJHJTVGTJ", // Athenee Tower
  "3-C62EJCKTEYJCCA", // Mega Bangna
  "3-C7CDRBXCC2T1NJ", // Siam Discovery
  "3-C7KGRRBBNPLGPE", // Siam Paragon
  "3-C6U1BACJN321NN", // Central Ladprao
  "3-C7K3EFBCPGB3VN", // Emsphere
]);
const isMaster = (id) => MASTER_IDS.has(id);

// ========== State ==========
let state = {
  merchants: {},
  events: [],
  view: "overview", // overview | search | branch
  currentBranchId: null,
  branchTab: "menu", // menu | log | hours
  filters: { search: "", availability: "all", category: "" },
  logFilter: { type: "" },
  searchQuery: "",
  ownership: "all", // all | master | franchise
};

// ========== Storage ==========
const isExtension = typeof chrome !== "undefined" && chrome.storage?.local;
const isFileScheme = location.protocol === "file:";
const SYNC_API = `${location.origin}/api/data`;

async function loadStorage() {
  if (isExtension) {
    return await new Promise((res) =>
      chrome.storage.local.get(["merchants", "events"], (d) => res(d || {})),
    );
  }
  // Try server (works for localhost AND production domain)
  if (!isFileScheme) {
    try {
      const r = await fetch(SYNC_API, { cache: "no-store", credentials: "same-origin" });
      if (r.status === 401) {
        location.replace("/login.html");
        return { merchants: {}, events: [] };
      }
      if (r.ok) return await r.json();
    } catch {}
  }
  try {
    return {
      merchants: JSON.parse(localStorage.getItem("grab.merchants") || "{}"),
      events: JSON.parse(localStorage.getItem("grab.events") || "[]"),
    };
  } catch {
    return { merchants: {}, events: [] };
  }
}

async function loadUser() {
  if (!isLocalhost) return null;
  try {
    const r = await fetch("/api/me", { credentials: "same-origin" });
    if (r.status === 401) {
      location.replace("/login.html");
      return null;
    }
    const j = await r.json();
    return j.user || null;
  } catch {
    return null;
  }
}

async function saveStorage(data) {
  if (isExtension) {
    return new Promise((res) => chrome.storage.local.set(data, () => res()));
  }
  if (data.merchants !== undefined) localStorage.setItem("grab.merchants", JSON.stringify(data.merchants));
  if (data.events !== undefined) localStorage.setItem("grab.events", JSON.stringify(data.events));
}

async function clearStorage() {
  if (isExtension) {
    return new Promise((res) => chrome.storage.local.clear(() => res()));
  }
  localStorage.removeItem("grab.merchants");
  localStorage.removeItem("grab.events");
}

async function load() {
  const data = await loadStorage();
  state.merchants = data.merchants || {};
  state.events = data.events || [];
  render();
}

// ========== Render ==========
function render() {
  const ids = Object.keys(state.merchants);
  if (ids.length === 0) {
    $("empty").classList.remove("hidden");
    $("content").classList.add("hidden");
    return;
  }
  $("empty").classList.add("hidden");
  $("content").classList.remove("hidden");

  // Update last-fetched
  const latestTs = Math.max(0, ...Object.values(state.merchants).map((m) => m.lastFetched || 0));
  $("last-fetched").textContent = latestTs ? `อัปเดตล่าสุด ${fmtRelative(latestTs)}` : "";

  // Show/hide views
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  $(`view-${state.view}`).classList.remove("hidden");

  // Top-nav active state
  document.querySelectorAll(".nav-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === state.view),
  );
  $("nav-branch").style.display = state.view === "branch" ? "block" : "none";

  if (state.view === "overview") renderOverview();
  else if (state.view === "search") renderSearch();
  else if (state.view === "branch") renderBranch();
}

function renderOverview() {
  const allMs = Object.values(state.merchants);
  const masterCount = allMs.filter((m) => isMaster(m.id)).length;
  const franchiseCount = allMs.length - masterCount;

  // Apply ownership filter
  let ms = allMs;
  if (state.ownership === "master") ms = allMs.filter((m) => isMaster(m.id));
  else if (state.ownership === "franchise") ms = allMs.filter((m) => !isMaster(m.id));

  // Unique menu types (deduplicated by name across all branches)
  const uniqueTypes = new Set();
  const uniqueAvailTypes = new Set();
  for (const m of ms) {
    for (const it of m.items || []) {
      const k = (it.name || "").trim().toLowerCase();
      if (!k) continue;
      uniqueTypes.add(k);
      if (it.isAvailable) uniqueAvailTypes.add(k);
    }
  }
  const totalItems = uniqueTypes.size;
  const totalAvail = uniqueAvailTypes.size;
  const totalUnavail = totalItems - totalAvail;
  const recentEvents = state.events.filter((e) => {
    if (e.ts <= Date.now() - 24 * 3600 * 1000) return false;
    // Count only menu state changes (open/close), not initial seed events
    if (e.type !== "OPENED" && e.type !== "CLOSED") return false;
    const branch = Object.values(state.merchants).find((m) => (m.items || []).some((i) => i.id === e.menuId));
    if (!branch) return true;
    if (state.ownership === "master") return isMaster(branch.id);
    if (state.ownership === "franchise") return !isMaster(branch.id);
    return true;
  }).length;

  const overallPct = totalItems > 0 ? Math.round((totalAvail / totalItems) * 100) : 0;
  $("overview-stats").innerHTML = `
    <div class="stat-card">
      <div class="stat-value">${ms.length}</div>
      <div class="stat-label">สาขา</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${totalItems}</div>
      <div class="stat-label">เมนูรวม</div>
    </div>
    <div class="stat-card green clickable" data-action="open-menu-status" data-mode="available" title="ดูเมนูที่เปิดขาย">
      <div class="stat-value green">${totalAvail}</div>
      <div class="stat-label">เปิดขาย · ${overallPct}% ▸</div>
    </div>
    <div class="stat-card red clickable" data-action="open-menu-status" data-mode="unavailable" title="ดูเมนูที่ปิดขาย">
      <div class="stat-value red">${totalUnavail}</div>
      <div class="stat-label">ปิดขาย ▸</div>
    </div>
    <div class="stat-card amber clickable" data-action="open-events" title="ดูรายการเปิด/ปิดเมนู">
      <div class="stat-value amber">${recentEvents}</div>
      <div class="stat-label">เปิด/ปิด 24 ชม. ▸</div>
    </div>
  `;

  // Rankings — Top 5 most/least available
  renderRankings(allMs);

  // Ownership filter pills
  const filterBar = $("ownership-filter");
  if (filterBar) {
    filterBar.innerHTML = `
      <button class="pill ${state.ownership === "all" ? "active" : ""}" data-ownership="all">
        ทั้งหมด <span class="pill-count">${allMs.length}</span>
      </button>
      <button class="pill ${state.ownership === "master" ? "active" : ""}" data-ownership="master">
        ⭐ Master <span class="pill-count">${masterCount}</span>
      </button>
      <button class="pill ${state.ownership === "franchise" ? "active" : ""}" data-ownership="franchise">
        Franchise <span class="pill-count">${franchiseCount}</span>
      </button>
    `;
    filterBar.querySelectorAll(".pill").forEach((b) => {
      b.addEventListener("click", () => {
        state.ownership = b.dataset.ownership;
        renderOverview();
      });
    });
  }

  // Branch cards
  const grid = $("branch-grid");
  grid.innerHTML = "";
  const sorted = ms.slice().sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  for (const m of sorted) {
    const items = m.items || [];
    const total = items.length;
    const avail = items.filter((i) => i.isAvailable).length;
    const unavail = total - avail;
    const pct = total > 0 ? Math.round((avail / total) * 100) : 0;
    const ago = m.lastFetched ? Date.now() - m.lastFetched : Infinity;
    const freshClass = ago < 6 * 3600 * 1000 ? "fresh" : ago < 24 * 3600 * 1000 ? "stale" : "cold";
    const barClass = pct >= 80 ? "" : pct >= 50 ? "mid" : "low";

    const card = document.createElement("article");
    card.className = "branch-card" + (isMaster(m.id) ? " is-master" : "");
    card.dataset.branchId = m.id;
    const tag = isMaster(m.id)
      ? `<span class="branch-tag master">⭐ MASTER</span>`
      : `<span class="branch-tag franchise">FC</span>`;
    card.innerHTML = `
      <div class="branch-card-header">
        <div class="branch-card-name">${escapeHtml(shortBranchName(m.name))}</div>
        ${tag}
      </div>
      <div class="branch-card-bar ${barClass}">
        <div class="branch-card-bar-fill" style="width:${pct}%"></div>
      </div>
      <div class="branch-card-stats">
        <div class="branch-card-stat">
          <div class="branch-card-stat-value">${total}</div>
          <div class="branch-card-stat-label">เมนู</div>
        </div>
        <div class="branch-card-stat">
          <div class="branch-card-stat-value green">${avail}</div>
          <div class="branch-card-stat-label">เปิดขาย</div>
        </div>
        <div class="branch-card-stat">
          <div class="branch-card-stat-value red">${unavail}</div>
          <div class="branch-card-stat-label">ปิดขาย</div>
        </div>
      </div>
      <div class="branch-card-foot">
        <div class="branch-card-pct"><b>${pct}%</b>เปิดขาย</div>
        <span class="branch-card-fresh ${freshClass}">${fmtRelative(m.lastFetched)}</span>
      </div>
    `;
    card.addEventListener("click", () => switchToBranch(m.id));
    grid.appendChild(card);
  }
}

function renderSearch() {
  const q = state.searchQuery.trim().toLowerCase();
  const out = $("search-results");
  if (!q) {
    out.innerHTML = `<p class="muted" style="text-align:center;padding:30px">พิมพ์ชื่อเมนูเพื่อค้นหาในทุกสาขา</p>`;
    return;
  }

  const matches = []; // [{branch, items}]
  for (const m of Object.values(state.merchants)) {
    const items = (m.items || []).filter(
      (i) =>
        (i.name || "").toLowerCase().includes(q) ||
        (i.description || "").toLowerCase().includes(q),
    );
    if (items.length > 0) matches.push({ merchant: m, items });
  }

  if (matches.length === 0) {
    out.innerHTML = `<p class="muted" style="text-align:center;padding:30px">ไม่พบ "${escapeHtml(q)}" ในสาขาใด</p>`;
    return;
  }

  const totalHits = matches.reduce((s, m) => s + m.items.length, 0);
  out.innerHTML = `<p class="muted">พบ <b>${totalHits}</b> รายการ ใน <b>${matches.length}</b> สาขา</p>`;

  for (const { merchant, items } of matches) {
    const group = document.createElement("div");
    group.className = "search-result-group";
    const availCount = items.filter((i) => i.isAvailable).length;
    group.innerHTML = `
      <div class="search-result-branch">
        ${escapeHtml(shortBranchName(merchant.name))}
        <span class="muted" style="font-weight:normal;font-size:11px">
          · ${availCount}/${items.length} ขายอยู่
        </span>
      </div>
    `;
    for (const it of items) {
      const row = document.createElement("div");
      row.className = "search-result-item";
      row.innerHTML = `
        <div class="search-result-item-name">${escapeHtml(it.name)}</div>
        <div class="search-result-item-status">
          <span>${fmtPrice(it.price)}</span>
          <span class="${it.isAvailable ? "" : ""}">${it.isAvailable ? "🟢" : "🔴"}</span>
        </div>
      `;
      group.appendChild(row);
    }
    group.addEventListener("click", () => switchToBranch(merchant.id));
    group.style.cursor = "pointer";
    out.appendChild(group);
  }
}

function openMenuStatusDialog(mode) {
  // mode: "available" or "unavailable"
  const allMs = Object.values(state.merchants);
  let ms = allMs;
  if (state.ownership === "master") ms = allMs.filter((m) => isMaster(m.id));
  else if (state.ownership === "franchise") ms = allMs.filter((m) => !isMaster(m.id));

  // Aggregate by menu name
  const byName = new Map();
  for (const m of ms) {
    const bn = (m.name || "?").split(" - ").slice(-1)[0].trim();
    for (const it of m.items || []) {
      const k = (it.name || "").trim().toLowerCase();
      if (!k) continue;
      if (!byName.has(k)) byName.set(k, { name: it.name, open: [], closed: [] });
      const target = it.isAvailable ? "open" : "closed";
      byName.get(k)[target].push({ branch: m, name: bn });
    }
  }

  let items = [...byName.values()].map((v) => ({
    ...v,
    total: v.open.length + v.closed.length,
    pct: v.open.length / (v.open.length + v.closed.length || 1),
  }));

  // Filter by mode
  if (mode === "available") {
    items = items.filter((i) => i.open.length > 0);
    items.sort((a, b) => b.open.length - a.open.length || b.pct - a.pct);
  } else {
    items = items.filter((i) => i.closed.length > 0);
    items.sort((a, b) => b.closed.length - a.closed.length || a.pct - b.pct);
  }

  $("menu-status-title").textContent =
    mode === "available" ? "🟢 เมนูที่เปิดขาย" : "🔴 เมนูที่ปิดขาย";
  $("menu-status-meta").textContent =
    mode === "available"
      ? `${items.length} เมนู (มีอย่างน้อย 1 สาขาเปิดขาย)`
      : `${items.length} เมนู (มีอย่างน้อย 1 สาขาปิดขาย)`;

  const list = $("menu-status-list");
  if (items.length === 0) {
    list.innerHTML = `<div class="event-empty">ไม่มีเมนูในกลุ่มนี้</div>`;
  } else {
    list.innerHTML = items
      .map((it, i) => {
        const open = it.open.length;
        const total = it.total;
        const pct = Math.round(it.pct * 100);
        const isAllOpen = it.closed.length === 0;
        const isAllClosed = it.open.length === 0;
        const tag = isAllOpen
          ? `<span class="ms-tag full-open">100% เปิด</span>`
          : isAllClosed
          ? `<span class="ms-tag all-closed">⚠ ปิดทุกสาขา</span>`
          : `<span class="ms-tag mixed">${pct}% เปิด</span>`;
        const branches = mode === "available" ? it.open : it.closed;
        const branchList = branches
          .slice(0, 6)
          .map((b) => `<span class="ms-branch">${escapeHtml(b.name.slice(0, 40))}</span>`)
          .join("");
        const more = branches.length > 6 ? `<span class="ms-more">+${branches.length - 6}</span>` : "";
        return `
          <details class="ms-row">
            <summary>
              <span class="ms-rank">${i + 1}</span>
              <span class="ms-name">${escapeHtml(it.name)}</span>
              <span class="ms-stat">
                <b class="${mode === "available" ? "green" : "red"}">${mode === "available" ? open : it.closed.length}</b>
                <span class="ms-divider">/</span>
                <span class="ms-total">${total}</span>
              </span>
              ${tag}
            </summary>
            <div class="ms-branches">${branchList}${more}</div>
          </details>
        `;
      })
      .join("");
  }
  $("menu-status-dialog").showModal();
}

function openEventsDialog() {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const events = state.events
    .filter((e) => e.ts > cutoff && (e.type === "OPENED" || e.type === "CLOSED"))
    .map((e) => {
      const branch = Object.values(state.merchants).find((m) => (m.items || []).some((i) => i.id === e.menuId));
      return { ...e, branch };
    })
    .filter((e) => {
      if (!e.branch) return state.ownership === "all";
      if (state.ownership === "master") return isMaster(e.branch.id);
      if (state.ownership === "franchise") return !isMaster(e.branch.id);
      return true;
    })
    .sort((a, b) => b.ts - a.ts);

  const opened = events.filter((e) => e.type === "OPENED").length;
  const closed = events.filter((e) => e.type === "CLOSED").length;
  $("events-dialog-meta").textContent = `${events.length} รายการ · ${opened} เปิด · ${closed} ปิด`;

  const list = $("events-list");
  if (events.length === 0) {
    list.innerHTML = `<div class="event-empty">ยังไม่มีการเปิด/ปิดเมนูใน 24 ชม.ที่ผ่านมา</div>`;
  } else {
    list.innerHTML = events
      .map((e) => `
        <div class="event-row" data-branch-id="${escapeHtml(e.branch?.id || "")}">
          <span class="event-time">${fmtTime(e.ts)}</span>
          <span class="event-pill ${e.type}">${e.type === "OPENED" ? "🟢 เปิด" : "🔴 ปิด"}</span>
          <span class="event-menu" title="${escapeHtml(e.menuName || e.menuId)}">${escapeHtml(e.menuName || e.menuId)}</span>
          <span class="event-branch">${escapeHtml(shortBranchName(e.branch?.name || "?"))}</span>
        </div>
      `)
      .join("");
    list.querySelectorAll(".event-row[data-branch-id]").forEach((row) => {
      const id = row.dataset.branchId;
      if (!id) return;
      row.style.cursor = "pointer";
      row.addEventListener("click", () => {
        $("events-dialog").close();
        switchToBranch(id);
      });
    });
  }
  $("events-dialog").showModal();
}

function renderRankings(allMs) {
  const enriched = allMs
    .filter((m) => (m.items || []).length > 0)
    .map((m) => {
      const items = m.items || [];
      const total = items.length;
      const avail = items.filter((i) => i.isAvailable).length;
      const pct = total > 0 ? Math.round((avail / total) * 100) : 0;
      return { m, total, avail, unavail: total - avail, pct };
    });

  const top = enriched
    .slice()
    .sort((a, b) => b.avail - a.avail || b.pct - a.pct)
    .slice(0, 5);
  const bottom = enriched
    .slice()
    .sort((a, b) => a.avail - b.avail || a.pct - b.pct)
    .slice(0, 5);

  const renderList = (list, target, type) => {
    target.innerHTML = "";
    list.forEach((row, i) => {
      const li = document.createElement("li");
      li.className = "ranking-item";
      li.innerHTML = `
        <span class="ranking-rank">${i + 1}</span>
        <div class="ranking-name">
          ${isMaster(row.m.id) ? '<span class="ranking-tag">⭐</span>' : ""}
          ${escapeHtml(shortBranchName(row.m.name))}
        </div>
        <div class="ranking-stat">
          <span class="ranking-num ${type === "top" ? "green" : "red"}">${row.avail}</span>
          <span class="ranking-divider">/</span>
          <span class="ranking-total">${row.total}</span>
          <span class="ranking-pct">${row.pct}%</span>
        </div>
      `;
      li.addEventListener("click", () => switchToBranch(row.m.id));
      target.appendChild(li);
    });
  };
  renderList(top, $("ranking-top"), "top");
  renderList(bottom, $("ranking-bottom"), "bottom");
}

function switchToBranch(branchId) {
  state.currentBranchId = branchId;
  state.view = "branch";
  state.branchTab = "menu";
  state.filters = { search: "", availability: "all", category: "" };
  render();
}

function renderBranch() {
  const branch = state.merchants[state.currentBranchId];
  if (!branch) {
    state.view = "overview";
    render();
    return;
  }

  $("branch-name").textContent = branch.name || branch.id;
  const meta = [];
  if (branch.address) meta.push(branch.address);
  if (branch.phone) meta.push(`☎ ${branch.phone}`);
  meta.push(`ID: ${branch.id}`);
  meta.push(`อัปเดต: ${fmtRelative(branch.lastFetched)}`);
  $("branch-meta").textContent = meta.join(" · ");

  // Stats
  const items = branch.items || [];
  const total = items.length;
  const avail = items.filter((i) => i.isAvailable).length;
  const unavail = total - avail;
  const eventsToday = state.events.filter(
    (e) => e.ts > Date.now() - 24 * 3600 * 1000 && belongsTo(e, branch),
  ).length;
  $("stats").innerHTML = `
    <div class="stat-card"><div class="stat-value">${total}</div><div class="stat-label">เมนูทั้งหมด</div></div>
    <div class="stat-card"><div class="stat-value green">${avail}</div><div class="stat-label">เปิดขายอยู่</div></div>
    <div class="stat-card"><div class="stat-value red">${unavail}</div><div class="stat-label">หมด/ปิด</div></div>
    <div class="stat-card"><div class="stat-value amber">${eventsToday}</div><div class="stat-label">เปลี่ยน (24 ชม.)</div></div>
  `;

  // Tabs
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === state.branchTab));
  document.querySelectorAll(".subview").forEach((v) => v.classList.add("hidden"));
  $(`view-${state.branchTab}`).classList.remove("hidden");

  // Categories dropdown
  const cats = Array.from(new Set(items.map((i) => i.category || "อื่นๆ")));
  const catSel = $("category-select");
  catSel.innerHTML = '<option value="">ทุกหมวดหมู่</option>';
  for (const c of cats) {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c;
    if (c === state.filters.category) opt.selected = true;
    catSel.appendChild(opt);
  }

  if (state.branchTab === "menu") renderMenuTab(branch);
  else if (state.branchTab === "log") renderLogTab(branch);
  else if (state.branchTab === "hours") renderHoursTab(branch);
}

function renderMenuTab(branch) {
  const items = (branch.items || []).filter((i) => {
    if (state.filters.search) {
      const q = state.filters.search.toLowerCase();
      if (!(i.name || "").toLowerCase().includes(q) && !(i.description || "").toLowerCase().includes(q))
        return false;
    }
    if (state.filters.availability === "available" && !i.isAvailable) return false;
    if (state.filters.availability === "unavailable" && i.isAvailable) return false;
    if (state.filters.category && (i.category || "อื่นๆ") !== state.filters.category) return false;
    return true;
  });

  const grouped = new Map();
  for (const it of items) {
    const k = it.category || "อื่นๆ";
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k).push(it);
  }

  const lastEvents = lastEventByMenu(branch);
  const list = $("menu-list");
  list.innerHTML = "";
  if (items.length === 0) {
    list.innerHTML = `<p class="muted" style="text-align:center;padding:40px">ไม่มีรายการตรงกับตัวกรอง</p>`;
    return;
  }
  for (const [cat, its] of grouped) {
    const availInCat = its.filter((i) => i.isAvailable).length;
    const section = document.createElement("section");
    section.className = "category";
    section.innerHTML = `
      <div class="category-head">
        <span class="category-name">${escapeHtml(cat)}</span>
        <span class="category-meta">${availInCat} / ${its.length} ขายอยู่</span>
      </div>
      <div class="menu-grid"></div>
    `;
    const grid = section.querySelector(".menu-grid");
    for (const it of its) grid.appendChild(menuCard(it, lastEvents.get(it.id)));
    list.appendChild(section);
  }
}

function menuCard(m, lastEvent) {
  const card = document.createElement("article");
  card.className = "menu-card" + (m.isAvailable ? "" : " unavailable");
  const img = m.imageUrl
    ? `<img src="${escapeHtml(m.imageUrl)}" alt="" class="menu-image${m.isAvailable ? "" : " unavail"}" referrerpolicy="no-referrer" loading="lazy" />`
    : `<div class="menu-image-empty">🍽️</div>`;
  const badge = m.isAvailable
    ? `<span class="menu-badge green">ขายอยู่</span>`
    : `<span class="menu-badge red">หมด</span>`;
  let statusLine = "";
  if (lastEvent) {
    if (lastEvent.type === "CLOSED") statusLine = `<div class="menu-status closed">❌ ปิด ${fmtTime(lastEvent.ts)} · ${fmtRelative(lastEvent.ts)}</div>`;
    else if (lastEvent.type === "OPENED") statusLine = `<div class="menu-status opened">✅ เปิด ${fmtTime(lastEvent.ts)} · ${fmtRelative(lastEvent.ts)}</div>`;
    else if (lastEvent.type === "PRICE_CHANGED") statusLine = `<div class="menu-status">💰 ราคาเปลี่ยน · ${fmtRelative(lastEvent.ts)}</div>`;
  }
  const desc = m.description ? `<div class="menu-desc">${escapeHtml(m.description)}</div>` : "";
  card.innerHTML = `
    <div class="menu-image-wrap">${img}${badge}</div>
    <div class="menu-body">
      <div class="menu-name">${escapeHtml(m.name)}</div>
      ${desc}
      <div class="menu-price">${fmtPrice(m.price)}</div>
      ${statusLine}
    </div>
  `;
  return card;
}

function renderLogTab(branch) {
  const events = state.events
    .filter((e) => belongsTo(e, branch))
    .filter((e) => !state.logFilter.type || e.type === state.logFilter.type)
    .slice()
    .reverse()
    .slice(0, 500);

  $("log-count").textContent = `${events.length} รายการ`;

  const labels = { OPENED: "เปิดขาย", CLOSED: "ปิด/หมด", PRICE_CHANGED: "ราคาเปลี่ยน", ADDED: "เพิ่มเมนู", REMOVED: "ลบ" };

  if (events.length === 0) {
    $("log-table").innerHTML = `<p class="muted" style="text-align:center;padding:40px">ยังไม่มี event</p>`;
    return;
  }

  const rows = events
    .map((e) => {
      let detail = "";
      if (e.type === "PRICE_CHANGED") detail = `${fmtPrice(e.from)} → ${fmtPrice(e.to)}`;
      return `
        <tr>
          <td class="muted" style="white-space:nowrap">${fmtDateTime(e.ts)}</td>
          <td>${escapeHtml(e.menuName || e.menuId)}</td>
          <td><span class="log-pill ${e.type}">${labels[e.type] || e.type}</span></td>
          <td class="muted">${detail}</td>
        </tr>
      `;
    })
    .join("");
  $("log-table").innerHTML = `
    <table class="log-table">
      <thead><tr><th>เวลา</th><th>เมนู</th><th>ประเภท</th><th>รายละเอียด</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderHoursTab(branch) {
  const container = $("hours-content");
  if (!branch.openHours) {
    container.innerHTML = `<p class="muted" style="text-align:center;padding:40px">ยังไม่มีข้อมูลเวลาเปิดร้าน</p>`;
    return;
  }
  let hours;
  try {
    hours = JSON.parse(branch.openHours);
  } catch {
    container.innerHTML = `<p class="muted">รูปแบบเวลาเปิดร้านอ่านไม่ออก</p>`;
    return;
  }
  const days = ["จันทร์", "อังคาร", "พุธ", "พฤหัสฯ", "ศุกร์", "เสาร์", "อาทิตย์"];
  let html = '<div class="hours-grid">';
  if (Array.isArray(hours)) {
    hours.forEach((dh, i) => {
      const day = days[i] || `วัน ${i + 1}`;
      const ranges = dh?.ranges;
      const text = Array.isArray(ranges) && ranges.length
        ? ranges.map((r) => `${r.start}–${r.end}`).join(", ")
        : "ปิด";
      html += `
        <div class="hours-card">
          <div class="hours-day">${day}</div>
          <div class="${text === "ปิด" ? "hours-closed" : "hours-range"}">${text}</div>
        </div>
      `;
    });
  } else {
    html += `<pre style="grid-column:1/-1;background:#fff;padding:12px;border-radius:6px;overflow:auto">${escapeHtml(JSON.stringify(hours, null, 2))}</pre>`;
  }
  html += "</div>";
  container.innerHTML = html;
}

function belongsTo(event, branch) {
  return (branch.items || []).some((i) => i.id === event.menuId);
}
function lastEventByMenu(branch) {
  const map = new Map();
  for (const e of state.events) {
    if (!belongsTo(e, branch)) continue;
    const cur = map.get(e.menuId);
    if (!cur || e.ts > cur.ts) map.set(e.menuId, e);
  }
  return map;
}

// ========== Event handlers ==========
async function initUserPill() {
  if (!isLocalhost) return;
  const user = await loadUser();
  if (!user) return;
  $("user-icon").textContent = user.role_icon || "👤";
  $("user-name").textContent = user.name || user.username;
  $("user-role").textContent = user.role_label || user.role || "";
}

document.addEventListener("DOMContentLoaded", () => {
  initUserPill();

  // Logout
  const logoutBtn = $("logout-btn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      try {
        await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
      } catch {}
      location.replace("/login.html");
    });
  }

  // Top-nav
  document.querySelectorAll(".nav-btn").forEach((b) => {
    b.addEventListener("click", () => {
      state.view = b.dataset.view;
      render();
    });
  });

  // Back to overview
  $("back-to-overview").addEventListener("click", () => {
    state.view = "overview";
    render();
  });

  // Cross search
  $("cross-search").addEventListener("input", (e) => {
    state.searchQuery = e.target.value;
    renderSearch();
  });

  // Branch tabs
  document.querySelectorAll(".tab").forEach((b) => {
    b.addEventListener("click", () => {
      state.branchTab = b.dataset.tab;
      render();
    });
  });

  $("search").addEventListener("input", (e) => {
    state.filters.search = e.target.value;
    renderMenuTab(state.merchants[state.currentBranchId]);
  });
  document.querySelectorAll(".pill").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll(".pill").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      state.filters.availability = b.dataset.filter;
      renderMenuTab(state.merchants[state.currentBranchId]);
    });
  });
  $("category-select").addEventListener("change", (e) => {
    state.filters.category = e.target.value;
    renderMenuTab(state.merchants[state.currentBranchId]);
  });
  $("log-type-filter").addEventListener("change", (e) => {
    state.logFilter.type = e.target.value;
    renderLogTab(state.merchants[state.currentBranchId]);
  });

  // Stat card click handlers
  $("overview-stats").addEventListener("click", (e) => {
    if (e.target.closest('[data-action="open-events"]')) openEventsDialog();
    const ms = e.target.closest('[data-action="open-menu-status"]');
    if (ms) openMenuStatusDialog(ms.dataset.mode);
  });
  $("events-dialog-close").addEventListener("click", () => $("events-dialog").close());
  $("menu-status-close").addEventListener("click", () => $("menu-status-dialog").close());

  // Refresh
  $("refresh-btn").addEventListener("click", async () => {
    const btn = $("refresh-btn");
    btn.classList.add("spinning");
    btn.disabled = true;
    try {
      await load();
    } finally {
      setTimeout(() => {
        btn.classList.remove("spinning");
        btn.disabled = false;
      }, 400);
    }
  });

  // Clear / Import / Export
  $("clear-btn")?.addEventListener("click", async () => {
    if (!confirm("ลบข้อมูลทั้งหมด (เมนู + log) จริงๆ?")) return;
    await clearStorage();
    state.merchants = {};
    state.events = [];
    state.view = "overview";
    state.currentBranchId = null;
    render();
  });

  const doExport = async () => {
    const data = await loadStorage();
    const text = JSON.stringify(data, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      alert("✅ Copy ข้อมูลใส่ clipboard แล้ว");
    } catch {
      const blob = new Blob([text], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `grab-menu-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    }
  };
  $("export-btn").addEventListener("click", doExport);

  const importDialog = $("import-dialog");
  const openImport = () => {
    $("import-text").value = "";
    importDialog.showModal();
  };
  $("import-btn")?.addEventListener("click", openImport);
  $("empty-import-btn")?.addEventListener("click", openImport);
  $("import-cancel").addEventListener("click", () => importDialog.close());
  $("import-submit").addEventListener("click", async () => {
    const txt = $("import-text").value.trim();
    if (!txt) return;
    try {
      const parsed = JSON.parse(txt);
      if (!parsed.merchants || typeof parsed.merchants !== "object") throw new Error("ไม่มี merchants");
      await saveStorage({ merchants: parsed.merchants, events: parsed.events || [] });
      importDialog.close();
      await load();
      alert(`✅ Import ${Object.keys(parsed.merchants).length} สาขา`);
    } catch (err) {
      alert("❌ JSON ไม่ถูก: " + err.message);
    }
  });

  load();

  if (isExtension) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.merchants || changes.events) load();
    });
  } else if (isLocalhost) {
    setInterval(load, 30000); // refresh from server every 30s
  }
});
