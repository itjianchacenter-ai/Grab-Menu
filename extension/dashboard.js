"use strict";

const $ = (id) => document.getElementById(id);

// ---------- formatters ----------
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
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

// ---------- state ----------
let state = {
  merchants: {},
  events: [],
  currentBranchId: null,
  view: "menu",
  filters: { search: "", availability: "all", category: "" },
  logFilter: { type: "" },
};

// Detect environment: extension (chrome.storage) vs standalone (localStorage / API)
const isExtension = typeof chrome !== "undefined" && chrome.storage?.local;
const isLocalhost = location.hostname === "localhost" || location.hostname === "127.0.0.1";
const SYNC_API = `${location.origin}/api/data`;

async function loadStorage() {
  if (isExtension) {
    return await new Promise((res) =>
      chrome.storage.local.get(["merchants", "events"], (d) => res(d || {})),
    );
  }
  if (isLocalhost) {
    try {
      const r = await fetch(SYNC_API, { cache: "no-store" });
      if (r.ok) return await r.json();
    } catch (_) {}
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
    $("content").classList.add("hidden");
    return;
  }
  $("empty").classList.add("hidden");
  $("content").classList.remove("hidden");

  // Branch dropdown
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
  if (!branch) return;

  $("last-fetched").textContent = `อัปเดต ${fmtRelative(branch.lastFetched)}`;
  $("branch-name").textContent = branch.name || branch.id;
  const meta = [];
  if (branch.address) meta.push(branch.address);
  if (branch.phone) meta.push(`☎ ${branch.phone}`);
  meta.push(`ID: ${branch.id}`);
  $("branch-meta").textContent = meta.join(" · ");

  renderStats(branch);
  renderCategoriesDropdown(branch);

  if (state.view === "menu") renderMenu(branch);
  else if (state.view === "log") renderLog(branch);
  else if (state.view === "hours") renderHours(branch);
}

function renderStats(branch) {
  const total = branch.items.length;
  const available = branch.items.filter((i) => i.isAvailable).length;
  const unavailable = total - available;
  const eventsToday = state.events.filter(
    (e) => e.ts > Date.now() - 24 * 3600 * 1000 && belongsTo(e, branch),
  ).length;

  $("stats").innerHTML = `
    <div class="stat-card">
      <div class="stat-value">${total}</div>
      <div class="stat-label">เมนูทั้งหมด</div>
    </div>
    <div class="stat-card">
      <div class="stat-value green">${available}</div>
      <div class="stat-label">เปิดขายอยู่</div>
    </div>
    <div class="stat-card">
      <div class="stat-value red">${unavailable}</div>
      <div class="stat-label">หมด/ปิด</div>
    </div>
    <div class="stat-card">
      <div class="stat-value amber">${eventsToday}</div>
      <div class="stat-label">เปลี่ยนแปลง (24 ชม.)</div>
    </div>
  `;
}

function renderCategoriesDropdown(branch) {
  const select = $("category-select");
  const cats = Array.from(new Set(branch.items.map((i) => i.category || "อื่นๆ")));
  select.innerHTML = '<option value="">ทุกหมวดหมู่</option>';
  for (const c of cats) {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c;
    if (c === state.filters.category) opt.selected = true;
    select.appendChild(opt);
  }
}

function belongsTo(event, branch) {
  return branch.items.some((i) => i.id === event.menuId);
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

function renderMenu(branch) {
  const filtered = branch.items.filter((i) => {
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
  for (const item of filtered) {
    const k = item.category || "อื่นๆ";
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k).push(item);
  }

  const lastEvents = lastEventByMenu(branch);
  const list = $("menu-list");
  list.innerHTML = "";

  if (filtered.length === 0) {
    list.innerHTML = `<p class="muted" style="text-align:center;padding:40px">ไม่มีรายการตรงกับตัวกรอง</p>`;
    return;
  }

  for (const [cat, items] of grouped) {
    const availInCat = items.filter((i) => i.isAvailable).length;
    const section = document.createElement("section");
    section.className = "category";
    section.innerHTML = `
      <div class="category-head">
        <span class="category-name">${escapeHtml(cat)}</span>
        <span class="category-meta">${availInCat} / ${items.length} ขายอยู่</span>
      </div>
      <div class="menu-grid"></div>
    `;
    const grid = section.querySelector(".menu-grid");
    for (const item of items) grid.appendChild(menuCard(item, lastEvents.get(item.id)));
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
    if (lastEvent.type === "CLOSED")
      statusLine = `<div class="menu-status closed">❌ ปิด ${fmtTime(lastEvent.ts)} · ${fmtRelative(lastEvent.ts)}</div>`;
    else if (lastEvent.type === "OPENED")
      statusLine = `<div class="menu-status opened">✅ เปิด ${fmtTime(lastEvent.ts)} · ${fmtRelative(lastEvent.ts)}</div>`;
    else if (lastEvent.type === "PRICE_CHANGED")
      statusLine = `<div class="menu-status">💰 ราคาเปลี่ยน · ${fmtRelative(lastEvent.ts)}</div>`;
    else if (lastEvent.type === "ADDED")
      statusLine = `<div class="menu-status">🆕 เพิ่มเมื่อ ${fmtRelative(lastEvent.ts)}</div>`;
  }

  const desc = m.description
    ? `<div class="menu-desc">${escapeHtml(m.description)}</div>`
    : "";

  card.innerHTML = `
    <div class="menu-image-wrap">
      ${img}
      ${badge}
    </div>
    <div class="menu-body">
      <div class="menu-name">${escapeHtml(m.name)}</div>
      ${desc}
      <div class="menu-price">${fmtPrice(m.price)}</div>
      ${statusLine}
    </div>
  `;
  return card;
}

function renderLog(branch) {
  const events = state.events
    .filter((e) => belongsTo(e, branch))
    .filter((e) => !state.logFilter.type || e.type === state.logFilter.type)
    .slice()
    .reverse()
    .slice(0, 500);

  $("log-count").textContent = `${events.length} รายการ`;

  const labels = {
    OPENED: "เปิดขาย",
    CLOSED: "ปิด/หมด",
    PRICE_CHANGED: "ราคาเปลี่ยน",
    ADDED: "เพิ่มเมนู",
    REMOVED: "ลบ",
  };

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
      <thead>
        <tr><th>เวลา</th><th>เมนู</th><th>ประเภท</th><th>รายละเอียด</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderHours(branch) {
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
      const day = days[i] || `วันที่ ${i + 1}`;
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

// ---------- Tab switching ----------
function switchTab(tab) {
  state.view = tab;
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  $(`view-${tab}`).classList.remove("hidden");
  render();
}

// ---------- Event listeners ----------
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  $("branch-select").addEventListener("change", (e) => {
    state.currentBranchId = e.target.value;
    render();
  });

  $("search").addEventListener("input", (e) => {
    state.filters.search = e.target.value;
    render();
  });

  document.querySelectorAll(".pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".pill").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.filters.availability = btn.dataset.filter;
      render();
    });
  });

  $("category-select").addEventListener("change", (e) => {
    state.filters.category = e.target.value;
    render();
  });

  $("log-type-filter").addEventListener("change", (e) => {
    state.logFilter.type = e.target.value;
    render();
  });

  $("clear-btn").addEventListener("click", async () => {
    if (!confirm("ลบข้อมูลทั้งหมด (เมนู + log) จริงๆ?")) return;
    await clearStorage();
    state = {
      merchants: {},
      events: [],
      currentBranchId: null,
      view: "menu",
      filters: { search: "", availability: "all", category: "" },
      logFilter: { type: "" },
    };
    render();
  });

  // Export data as JSON
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

  // Import dialog
  const importDialog = $("import-dialog");
  const openImport = () => {
    $("import-text").value = "";
    importDialog.showModal();
  };
  $("import-btn").addEventListener("click", openImport);
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
      alert(`✅ Import ${Object.keys(parsed.merchants).length} สาขา · ${(parsed.events || []).length} events`);
    } catch (err) {
      alert("❌ JSON ไม่ถูกต้อง: " + err.message);
    }
  });

  // Hide hint if running standalone (not in extension)
  if (!isExtension) {
    const hint = $("empty-hint");
    if (hint) {
      hint.innerHTML = isLocalhost
        ? "Local server พร้อม — เปิดหน้า merchant.grab.com ใน Chrome (มี extension) ข้อมูลจะ sync มาที่นี่อัตโนมัติทุกครั้งที่ refresh"
        : "นี่คือ Local mode — กดปุ่ม Import แล้ววาง JSON จาก Chrome Extension";
    }
  }

  load();

  if (isExtension) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.merchants || changes.events) load();
    });
  } else if (isLocalhost) {
    setInterval(load, 5000); // poll local server every 5s
  } else {
    window.addEventListener("storage", (e) => {
      if (e.key === "grab.merchants" || e.key === "grab.events") load();
    });
  }
});
