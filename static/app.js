const app = document.querySelector("#app");
let state = { user: null, view: "dashboard", equipment: [], selected: null };

const roleLabels = {
  administrator: "Administrator",
  front_end: "Front-end User",
  store_manager: "Store Manager",
  store: "Store Officer"
};

function can(permission) {
  if (!state.user) return false;
  if (state.user.role === "administrator") return true;
  const rules = {
    front_end: ["request:create", "return:create", "inventory:read"],
    store_manager: ["request:approve", "return:approve", "inventory:read", "dashboard:read"],
    store: ["inventory:read", "inventory:update", "movement:check", "dashboard:read"]
  };
  return (rules[state.user.role] || []).includes(permission);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    ...options
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function renderLogin(message = "") {
  app.className = "login";
  app.innerHTML = `
    <section class="login-card">
      <h1>VTCC Maintenance Store</h1>
      <p class="hint">Inventory, QR lookup, requests, approvals, and stock level dashboard.</p>
      <form id="loginForm">
        <label>Username <input name="username" value="admin" autocomplete="username"></label>
        <label>Password <input name="password" type="password" value="admin123" autocomplete="current-password"></label>
        <button>Log in</button>
      </form>
      <div class="message">${message}</div>
      <p class="hint">Seed users: admin/admin123, front/front123, manager/manager123, store/store123.</p>
    </section>
  `;
  document.querySelector("#loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const data = await api("/api/login", { method: "POST", body: JSON.stringify(formData(event.target)) });
      state.user = data.user;
      state.view = can("dashboard:read") ? "dashboard" : "inventory";
      renderShell();
    } catch (err) {
      renderLogin(err.message);
    }
  });
}

function navItems() {
  return [
    ["dashboard", "Dashboard", can("dashboard:read")],
    ["inventory", "Equipment", can("inventory:read")],
    ["requests", "Requests / Returns", true],
    ["users", "Users", state.user?.role === "administrator"]
  ].filter(item => item[2]);
}

function renderShell() {
  app.className = "shell";
  app.innerHTML = `
    <aside class="sidebar">
      <div class="brand">VTCC Store Inventory</div>
      <div class="role">${state.user.full_name}<br>${roleLabels[state.user.role]}</div>
      <nav class="nav">
        ${navItems().map(([id, label]) => `<button data-view="${id}" class="${state.view === id ? "active" : ""}">${label}</button>`).join("")}
        <button id="logout">Log out</button>
      </nav>
    </aside>
    <section class="content" id="content"></section>
  `;
  document.querySelectorAll("[data-view]").forEach(btn => btn.addEventListener("click", () => {
    state.view = btn.dataset.view;
    renderShell();
  }));
  document.querySelector("#logout").addEventListener("click", async () => {
    await api("/api/logout", { method: "POST" });
    state.user = null;
    renderLogin();
  });
  if (state.view === "dashboard") loadDashboard();
  if (state.view === "inventory") loadInventory();
  if (state.view === "requests") loadRequests();
  if (state.view === "users") loadUsers();
}

function content(title, body, tools = "") {
  document.querySelector("#content").innerHTML = `
    <div class="topbar"><h1>${title}</h1><div class="toolbar">${tools}</div></div>
    ${body}
  `;
}

async function loadDashboard() {
  const data = await api("/api/dashboard");
  content("Dashboard", `
    <div class="stats">
      <div class="stat">Total equipment <b>${data.total_items}</b></div>
      <div class="stat">Below minimum <b>${data.low_stock.length}</b></div>
      <div class="stat">Above maximum <b>${data.over_stock.length}</b></div>
      <div class="stat">Pending requests <b>${data.pending_requests}</b></div>
    </div>
    <div class="grid-2">
      <section class="panel"><h2>Minimum stock alerts</h2>${equipmentTable(data.low_stock, false)}</section>
      <section class="panel"><h2>Maximum stock alerts</h2>${equipmentTable(data.over_stock, false)}</section>
    </div>
    <section class="panel" style="margin-top:14px"><h2>Recent store movements</h2>
      <table><thead><tr><th>Time</th><th>Equipment</th><th>Type</th><th>Qty</th><th>User</th></tr></thead>
      <tbody>${data.recent_movements.map(m => `<tr><td>${m.created_at}</td><td>${m.equipment_no}<br>${m.name}</td><td>${m.movement_type}</td><td>${m.quantity}</td><td>${m.full_name}</td></tr>`).join("") || `<tr><td colspan="5">No movements yet</td></tr>`}</tbody></table>
    </section>
  `);
}

function stockBadge(item) {
  if (item.quantity < item.minimum_qty) return `<span class="badge low">Below min</span>`;
  if (item.maximum_qty > 0 && item.quantity > item.maximum_qty) return `<span class="badge over">Above max</span>`;
  return `<span class="badge ok">OK</span>`;
}

function equipmentTable(items, actions = true) {
  return `
    <table><thead><tr><th>No.</th><th>Name</th><th>Qty</th><th>Min/Max</th><th>Status</th>${actions ? "<th>Actions</th>" : ""}</tr></thead>
    <tbody>${items.map(item => `
      <tr>
        <td>${item.equipment_no}<br><span class="hint">${item.location}</span></td>
        <td>${item.name}<br><span class="hint">${item.category}</span></td>
        <td>${item.quantity} ${item.unit}</td>
        <td>${item.minimum_qty} / ${item.maximum_qty}</td>
        <td>${stockBadge(item)}</td>
        ${actions ? `<td class="actions"><button class="secondary" data-edit="${item.id}">Open</button></td>` : ""}
      </tr>`).join("") || `<tr><td colspan="${actions ? 6 : 5}">No equipment found</td></tr>`}</tbody></table>`;
}

async function loadInventory(q = "") {
  const data = await api(`/api/equipment?q=${encodeURIComponent(q)}`);
  state.equipment = data.equipment;
  content("Equipment", `
    <div class="inventory-layout">
      <section class="panel">
        <div class="toolbar">
          <input id="search" placeholder="Search or scan equipment number" value="${q}">
          <button id="searchBtn" class="secondary">Search</button>
          <button id="scanBtn" class="secondary">Scan QR</button>
        </div>
        <div id="scanArea" class="hidden" style="margin-top:12px">
          <video id="reader" muted playsinline></video>
          <p class="hint">Camera scanning uses the browser BarcodeDetector when available. Manual equipment number entry always works.</p>
        </div>
        <div style="margin-top:12px">${equipmentTable(data.equipment)}</div>
      </section>
      <section class="panel">
        <h2>${can("inventory:update") ? "Create / update equipment" : "Equipment detail"}</h2>
        ${equipmentForm()}
        <div id="qrPreview" class="qr-box">Open an item to show its QR code</div>
      </section>
    </div>
  `);
  document.querySelector("#searchBtn").onclick = () => loadInventory(document.querySelector("#search").value);
  document.querySelector("#search").onkeydown = (e) => { if (e.key === "Enter") loadInventory(e.target.value); };
  document.querySelector("#scanBtn").onclick = startScanner;
  document.querySelectorAll("[data-edit]").forEach(btn => btn.onclick = () => editEquipment(btn.dataset.edit));
  document.querySelector("#equipmentForm").onsubmit = saveEquipment;
  document.querySelector("#clearForm").onclick = () => fillEquipment();
  if (!can("inventory:update")) document.querySelectorAll("#equipmentForm input, #equipmentForm textarea, #equipmentForm select, #equipmentForm button[type=submit]").forEach(el => el.disabled = true);
}

function equipmentForm(item = {}) {
  return `
    <form id="equipmentForm" class="form-grid">
      <input name="id" type="hidden" value="${item.id || ""}">
      <label>Equipment number <input name="equipment_no" required value="${item.equipment_no || ""}"></label>
      <label>Name <input name="name" required value="${item.name || ""}"></label>
      <label>Category <input name="category" required value="${item.category || ""}"></label>
      <label>Location <input name="location" required value="${item.location || ""}"></label>
      <div class="grid-2">
        <label>Quantity <input name="quantity" type="number" min="0" value="${item.quantity || 0}"></label>
        <label>Unit <input name="unit" value="${item.unit || "pcs"}"></label>
      </div>
      <div class="grid-2">
        <label>Minimum <input name="minimum_qty" type="number" min="0" value="${item.minimum_qty || 0}"></label>
        <label>Maximum <input name="maximum_qty" type="number" min="0" value="${item.maximum_qty || 0}"></label>
      </div>
      <label>Status <select name="status"><option>available</option><option>maintenance</option><option>retired</option></select></label>
      <label>Notes <textarea name="notes">${item.notes || ""}</textarea></label>
      <div class="actions"><button type="submit">Save</button><button type="button" class="secondary" id="clearForm">Clear</button></div>
    </form>
  `;
}

function fillEquipment(item = {}) {
  document.querySelector(".panel:nth-child(2)").innerHTML = `<h2>${can("inventory:update") ? "Create / update equipment" : "Equipment detail"}</h2>${equipmentForm(item)}<div id="qrPreview" class="qr-box">${item.equipment_no ? qrSvg(item.equipment_no) : "Open an item to show its QR code"}</div>`;
  document.querySelector("#equipmentForm").onsubmit = saveEquipment;
  document.querySelector("#clearForm").onclick = () => fillEquipment();
  if (item.status) document.querySelector("[name=status]").value = item.status;
  if (!can("inventory:update")) document.querySelectorAll("#equipmentForm input, #equipmentForm textarea, #equipmentForm select, #equipmentForm button[type=submit]").forEach(el => el.disabled = true);
}

async function editEquipment(id) {
  const data = await api(`/api/equipment/${id}`);
  fillEquipment(data.equipment);
}

async function saveEquipment(event) {
  event.preventDefault();
  const data = formData(event.target);
  const id = data.id;
  delete data.id;
  await api(id ? `/api/equipment/${id}` : "/api/equipment", { method: id ? "PUT" : "POST", body: JSON.stringify(data) });
  await loadInventory();
}

async function startScanner() {
  const area = document.querySelector("#scanArea");
  const video = document.querySelector("#reader");
  area.classList.remove("hidden");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    video.srcObject = stream;
    await video.play();
    if (!("BarcodeDetector" in window)) return;
    const detector = new BarcodeDetector({ formats: ["qr_code"] });
    const tick = async () => {
      if (video.srcObject) {
        const codes = await detector.detect(video);
        if (codes.length) {
          const value = codes[0].rawValue.trim();
          stream.getTracks().forEach(track => track.stop());
          document.querySelector("#search").value = value;
          loadInventory(value);
          return;
        }
        requestAnimationFrame(tick);
      }
    };
    tick();
  } catch (err) {
    area.innerHTML = `<p class="message">${err.message}</p>`;
  }
}

function qrSvg(text) {
  let bits = [...text].map(ch => ch.charCodeAt(0).toString(2).padStart(8, "0")).join("");
  let cells = "";
  for (let y = 0; y < 21; y++) {
    for (let x = 0; x < 21; x++) {
      const finder = (x < 7 && y < 7) || (x > 13 && y < 7) || (x < 7 && y > 13);
      const on = finder ? (x % 6 === 0 || y % 6 === 0 || (x > 1 && x < 5 && y > 1 && y < 5) || (x > 15 && x < 19 && y > 1 && y < 5) || (x > 1 && x < 5 && y > 15 && y < 19)) : bits[(x * 13 + y * 7) % bits.length] === "1";
      if (on) cells += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
    }
  }
  return `<div><svg viewBox="0 0 21 21" width="150" height="150" aria-label="QR marker"><rect width="21" height="21" fill="white"/><g fill="black">${cells}</g></svg><p class="hint">${text}</p></div>`;
}

async function loadRequests() {
  const data = await api("/api/requests");
  const canCreate = can("request:create");
  content("Requests / Returns", `
    ${canCreate ? `<section class="panel"><form id="requestForm" class="form-grid">
      <div class="grid-2">
        <label>Type <select name="request_type"><option value="request">Request equipment</option><option value="return">Return equipment</option></select></label>
        <label>Equipment <select name="equipment_id">${state.equipment.map(e => `<option value="${e.id}">${e.equipment_no} - ${e.name}</option>`).join("")}</select></label>
      </div>
      <div class="grid-2"><label>Quantity <input name="quantity" type="number" min="1" value="1"></label><label>Purpose <input name="purpose"></label></div>
      <button>Submit</button>
    </form></section>` : ""}
    <section class="panel" style="margin-top:14px">
      <table><thead><tr><th>ID</th><th>Equipment</th><th>Type</th><th>Qty</th><th>Status</th><th>Requester</th><th>Actions</th></tr></thead>
      <tbody>${data.requests.map(r => `<tr>
        <td>#${r.id}</td><td>${r.equipment_no}<br>${r.name}</td><td>${r.request_type}</td><td>${r.quantity}</td><td><span class="badge">${r.status}</span></td><td>${r.requester_name}</td>
        <td class="actions">${can("request:approve") && r.status === "pending" ? `<button data-approve="${r.id}">Approve</button><button class="danger" data-reject="${r.id}">Reject</button>` : ""}</td>
      </tr>`).join("") || `<tr><td colspan="7">No requests yet</td></tr>`}</tbody></table>
    </section>
  `);
  if (canCreate) {
    if (!state.equipment.length) {
      const eq = await api("/api/equipment");
      state.equipment = eq.equipment;
      return loadRequests();
    }
    document.querySelector("#requestForm").onsubmit = async (event) => {
      event.preventDefault();
      await api("/api/requests", { method: "POST", body: JSON.stringify(formData(event.target)) });
      loadRequests();
    };
  }
  document.querySelectorAll("[data-approve]").forEach(btn => btn.onclick = () => decide(btn.dataset.approve, "approved"));
  document.querySelectorAll("[data-reject]").forEach(btn => btn.onclick = () => decide(btn.dataset.reject, "rejected"));
}

async function decide(id, status) {
  await api(`/api/requests/${id}`, { method: "PUT", body: JSON.stringify({ status }) });
  loadRequests();
}

async function loadUsers() {
  const data = await api("/api/users");
  content("Users", `
    <section class="panel"><form id="userForm" class="form-grid">
      <div class="grid-2"><label>Username <input name="username" required></label><label>Full name <input name="full_name" required></label></div>
      <div class="grid-2"><label>Password <input name="password" type="password" required></label><label>Role <select name="role">${Object.entries(roleLabels).map(([k,v]) => `<option value="${k}">${v}</option>`).join("")}</select></label></div>
      <button>Create user</button>
    </form></section>
    <section class="panel" style="margin-top:14px"><table><thead><tr><th>User</th><th>Name</th><th>Role</th><th>Active</th></tr></thead>
    <tbody>${data.users.map(u => `<tr><td>${u.username}</td><td>${u.full_name}</td><td>${roleLabels[u.role]}</td><td>${u.active ? "Yes" : "No"}</td></tr>`).join("")}</tbody></table></section>
  `);
  document.querySelector("#userForm").onsubmit = async (event) => {
    event.preventDefault();
    await api("/api/users", { method: "POST", body: JSON.stringify(formData(event.target)) });
    loadUsers();
  };
}

async function boot() {
  const data = await api("/api/me");
  state.user = data.user;
  if (!state.user) return renderLogin();
  state.view = can("dashboard:read") ? "dashboard" : "inventory";
  renderShell();
}

boot().catch(() => renderLogin());
