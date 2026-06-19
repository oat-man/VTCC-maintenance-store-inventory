const app = document.querySelector("#app");
let state = {
  user: null,
  view: "dashboard",
  equipment: [],
  master: null,
  orders: [],
  equipmentMode: "idle",
  editingEquipmentId: null,
  equipmentDraft: {},
  userMode: "idle",
  editingUserId: null,
  userDraft: {},
  masterMode: "idle",
  editingMasterId: null,
  masterDraft: {},
};

const roleLabels = {
  administrator: "Administrator",
  front_end: "Front-end User",
  store_manager: "Store Manager",
  store: "Store Officer",
};
const rules = {
  front_end: [
    "request:create",
    "return:create",
    "inventory:read",
    "notifications:read",
  ],
  store_manager: [
    "master:manage",
    "equipment:create",
    "equipment:update",
    "orders:read",
    "inventory:read",
    "dashboard:read",
  ],
  store: [
    "inventory:read",
    "equipment:update",
    "purchase:create",
    "request:manage",
    "return:manage",
    "orders:read",
    "dashboard:read",
    "notifications:read",
  ],
};
function can(permission) {
  return (
    state.user &&
    (state.user.role === "administrator" ||
      (rules[state.user.role] || []).includes(permission))
  );
}
async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}
function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}
function esc(value = "") {
  return String(value ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
}
function optionRows(items, valueKey, labelFn, selected = "") {
  return items
    .map(
      (x) =>
        `<option value="${x[valueKey]}" ${String(x[valueKey]) === String(selected) ? "selected" : ""}>${esc(labelFn(x))}</option>`,
    )
    .join("");
}
function localTime(value) {
  if (!value) return "";
  const date = new Date(`${value.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function renderLogin(message = "") {
  app.className = "login";
  app.innerHTML = `<section class="login-card"><h1>VTCC Maintenance Store</h1><p class="hint">Inventory, master data, purchase, request, return, notifications, and syslog.</p><form id="loginForm"><label>Username <input name="username" value="admin" autocomplete="username"></label><label>Password <input name="password" type="password" value="admin123" autocomplete="current-password"></label><button>Log in</button></form><div class="message">${esc(message)}</div><p class="hint">Seed users: admin/admin123, front/front123, manager/manager123, store/store123.</p></section>`;
  document.querySelector("#loginForm").onsubmit = async (event) => {
    event.preventDefault();
    try {
      const data = await api("/api/login", {
        method: "POST",
        body: JSON.stringify(formData(event.target)),
      });
      state.user = data.user;
      state.view = defaultView();
      renderShell();
    } catch (err) {
      renderLogin(err.message);
    }
  };
}
function defaultView() {
  return state.user?.role === "administrator"
    ? "users"
    : can("dashboard:read")
      ? "dashboard"
      : "requests";
}
function navItems() {
  const operational =
    state.user?.role === "administrator"
      ? []
      : [
          ["dashboard", "Dashboard", can("dashboard:read")],
          ["equipment", "Equipment", can("inventory:read")],
          ["purchase", "Purchase Orders", can("purchase:create")],
          [
            "requests",
            "Requests",
            can("request:create") ||
              can("request:manage") ||
              can("orders:read"),
          ],
          [
            "returns",
            "Returns",
            can("return:create") || can("return:manage") || can("orders:read"),
          ],
          ["notifications", "Notifications", can("notifications:read")],
        ];
  const master =
    state.user?.role === "administrator"
      ? []
      : [
          ["categories", "Category", can("master:manage"), "master"],
          ["groups", "Group", can("master:manage"), "master"],
          ["locations", "Location Store", can("master:manage"), "master"],
        ];
  const administration = [
    [
      "users",
      state.user?.role === "administrator"
        ? "Manage User and Role"
        : "Users / Roles",
      state.user?.role === "administrator",
    ],
    [
      "syslog",
      state.user?.role === "administrator" ? "See Syslog" : "Syslog",
      state.user?.role === "administrator",
    ],
  ];
  return [...operational, ...master, ...administration].filter(
    (item) => item[2],
  );
}
function renderNavigation(items) {
  let masterHeadingAdded = false;
  return items
    .map(([id, label, , section]) => {
      const heading =
        section === "master" && !masterHeadingAdded
          ? ((masterHeadingAdded = true),
            '<div class="nav-group-label">Master Data</div>')
          : "";
      return `${heading}<button data-view="${id}" class="${state.view === id ? "active" : ""} ${section === "master" ? "nav-subitem" : ""}">${label}</button>`;
    })
    .join("");
}
function renderShell() {
  app.className = "shell";
  const items = navItems();
  if (!items.some(([id]) => id === state.view))
    state.view = items[0]?.[0] || defaultView();
  app.innerHTML = `<aside class="sidebar" id="sidebar"><div class="brand"><button id="menuToggle" class="icon-btn" title="Toggle menu">0</button><span>VTCC Store Inventory</span></div><div class="role">${esc(state.user.full_name)}<br>${roleLabels[state.user.role]}</div><nav class="nav">${renderNavigation(items)}<button id="logout">Log out</button></nav></aside><section class="content" id="content"></section>`;
  document.querySelector("#menuToggle").onclick = () =>
    document.querySelector("#sidebar").classList.toggle("collapsed");
  document.querySelectorAll("[data-view]").forEach(
    (btn) =>
      (btn.onclick = () => {
        resetMasterMode();
        state.view = btn.dataset.view;
        renderShell();
      }),
  );
  document.querySelector("#logout").onclick = async () => {
    await api("/api/logout", { method: "POST" });
    state.user = null;
    renderLogin();
  };
  (
    ({
      dashboard: loadDashboard,
      equipment: loadEquipment,
      purchase: loadPurchase,
      requests: () => loadOrders("request"),
      returns: () => loadOrders("return"),
      notifications: loadNotifications,
      categories: () => loadMaster("categories"),
      groups: () => loadMaster("groups"),
      locations: () => loadMaster("locations"),
      users: loadUsers,
      syslog: loadSyslog,
    })[state.view] || loadEquipment
  )();
}
function content(title, body, tools = "") {
  document.querySelector("#content").innerHTML =
    `<div class="topbar"><h1>${title}</h1><div class="toolbar">${tools}</div></div>${body}`;
}
async function ensureMaster() {
  if (!state.master) state.master = await api("/api/master");
  return state.master;
}
async function ensureEquipment() {
  const data = await api("/api/equipment");
  state.equipment = data.equipment;
  return state.equipment;
}

async function loadDashboard() {
  const d = await api("/api/dashboard");
  content(
    "Dashboard",
    `<div class="stats"><div class="stat">Total equipment <b>${d.total_items}</b></div><div class="stat">Below minimum <b>${d.low_stock.length}</b></div><div class="stat">Pending requests <b>${d.pending_requests}</b></div><div class="stat">Pending returns <b>${d.pending_returns}</b></div></div><div class="grid-2"><section class="panel"><h2>Minimum stock alerts</h2>${equipmentTable(d.low_stock, false)}</section><section class="panel"><h2>Recent store movements</h2><table><thead><tr><th>Time</th><th>Equipment</th><th>Type</th><th>Qty</th><th>User</th></tr></thead><tbody>${d.recent_movements.map((m) => `<tr><td>${m.created_at}</td><td>${esc(m.name)}</td><td>${esc(m.movement_type)}</td><td>${m.quantity}</td><td>${esc(m.full_name)}</td></tr>`).join("") || `<tr><td colspan="5">No movements yet</td></tr>`}</tbody></table></section></div>`,
  );
}
function stockBadge(item) {
  if (item.quantity < item.minimum_qty)
    return `<span class="badge low">Below min</span>`;
  if (item.maximum_qty > 0 && item.quantity > item.maximum_qty)
    return `<span class="badge over">Above max</span>`;
  return `<span class="badge ok">OK</span>`;
}
function equipmentBusy() {
  return state.equipmentMode === "create" || state.equipmentMode === "edit";
}
function resetEquipmentMode() {
  state.equipmentMode = "idle";
  state.editingEquipmentId = null;
  state.equipmentDraft = {};
}
function equipmentTable(items, actions = can("equipment:update")) {
  return `<table><thead><tr><th>Equipment</th><th>Category</th><th>Group / Location</th><th>In Stock</th><th>Return Stock</th><th>Status</th>${actions ? "<th>Actions</th>" : ""}</tr></thead><tbody>${items.map((item) => `<tr><td>${esc(item.name)}</td><td>${esc(item.category_name || item.category)}</td><td>${esc(item.group_name || "-")}<br><span class="hint">${esc(item.location_name || item.location)}</span></td><td>${item.quantity} ${esc(item.unit)}</td><td>${item.return_quantity || 0}</td><td>${stockBadge(item)}</td>${actions ? `<td class="actions"><button class="secondary" data-edit="${item.id}" ${equipmentBusy() ? "disabled" : ""}>Edit</button></td>` : ""}</tr>`).join("") || `<tr><td colspan="${actions ? 7 : 6}">No equipment found</td></tr>`}</tbody></table>`;
}
async function loadEquipment(q = "") {
  const [m, data] = await Promise.all([
    ensureMaster(),
    api(`/api/equipment?q=${encodeURIComponent(q)}`),
  ]);
  state.equipment = data.equipment;

  const detailTitle =
    state.equipmentMode === "edit"
      ? "Update equipment"
      : state.equipmentMode === "create"
        ? "Create equipment"
        : "Equipment detail";

  const draft = state.equipmentDraft || {};
  content(
    "Equipment",
    `<div class="inventory-layout"><section class="panel"><div class="toolbar"><input id="search" placeholder="Search equipment or scan QR code" value=""><button id="searchBtn" class="secondary">Search</button><button id="scanBtn" class="secondary">Scan QR</button></div><div id="scanArea" class="hidden"><video id="reader" muted playsinline></video><p class="hint">Camera scanning uses BarcodeDetector when available. Manual QR-code entry always works.</p></div><div class="table-wrap">${equipmentTable(data.equipment)}</div></section><section class="panel"><h2>${detailTitle}</h2>${equipmentForm(draft, m)}<div id="qrPreview" class="qr-box">${draft.equipment_no ? qrSvg(draft.equipment_no) : "QR-Code will show after generation"}</div></section></div>`,
  );
  document.querySelector("#searchBtn").onclick = () =>
    loadEquipment(document.querySelector("#search").value);
  document.querySelector("#search").onkeydown = (e) => {
    if (e.key === "Enter") loadEquipment(e.target.value);
  };
  document.querySelector("#scanBtn").onclick = startScanner;
  document
    .querySelectorAll("[data-edit]")
    .forEach((btn) => (btn.onclick = () => editEquipment(btn.dataset.edit)));
  bindEquipmentForm();
}
function equipmentForm(item = {}, m = state.master) {
  const active = equipmentBusy();
  const createMode = state.equipmentMode === "create";
  const editMode = state.equipmentMode === "edit";
  const canCreate = can("equipment:create");
  const canUpdate = can("equipment:update");
  const canSave = (createMode && canCreate) || (editMode && canUpdate);
  const qrButton = `<button type="button" class="secondary" id="generateQr" ${createMode ? "" : "disabled"}>Generate QR-Code</button>`;
  const uniqueField = editMode
    ? `<label>Unique no. <span class="unique-row"><input value="${esc(item.equipment_no)}" disabled><input name="equipment_no" type="hidden" value="${esc(item.equipment_no)}">${qrButton}</span></label>`
    : `<label>Unique no. <span class="unique-row"><input name="equipment_no" value="${esc(item.equipment_no)}" ${createMode ? "" : "disabled"}>${qrButton}</span></label>`;
  const disabled = canSave ? "" : "disabled";
  const actions = active
    ? `<button type="submit" ${canSave ? "" : "disabled"}>Save</button><button type="button" class="secondary" id="cancelEquipment">Cancel</button>`
    : `${canCreate ? `<button type="button" id="startEquipmentCreate">Create</button>` : ""}
      ${canUpdate ? `<span class="hint">Select an equipment item to update.</span>` : ""}`;
  return `<form id="equipmentForm" class="form-grid"><input name="id" type="hidden" value="${item.id || ""}">${uniqueField}<label>Name <input name="name" required value="${esc(item.name)}" ${disabled}></label><div class="grid-2"><label>Category <select name="category_id" required ${disabled}>${optionRows(
    m.categories.filter((x) => x.active || x.id === item.category_id),
    "id",
    (x) => `${x.category_no} - ${x.name}`,
    item.category_id,
  )}</select></label><label>Group <select name="group_id" ${disabled}><option value="">None</option>${optionRows(
    m.groups.filter((x) => x.active || x.id === item.group_id),
    "id",
    (x) => `${x.group_no} - ${x.name}`,
    item.group_id,
  )}</select></label></div><label>Location store <select name="location_id" required ${disabled}>${optionRows(
    m.locations.filter((x) => x.active || x.id === item.location_id),
    "id",
    (x) => `${x.locate_no} - ${x.name}`,
    item.location_id,
  )}</select></label><div class="grid-2"><label>In-stock quantity <input name="quantity" type="number" min="0" value="${item.quantity || 0}" ${disabled}></label><label>Unit <input name="unit" value="${esc(item.unit || "pcs")}" ${disabled}></label></div><div class="grid-2"><label>Minimum <input name="minimum_qty" type="number" min="0" value="${item.minimum_qty || 0}" ${disabled}></label><label>Maximum <input name="maximum_qty" type="number" min="0" value="${item.maximum_qty || 0}" ${disabled}></label></div><label>Status <select name="status" ${disabled}><option ${item.status === "available" ? "selected" : ""}>available</option><option ${item.status === "maintenance" ? "selected" : ""}>maintenance</option><option ${item.status === "retired" ? "selected" : ""}>retired</option></select></label><label>Notes <textarea name="notes" ${disabled}>${esc(item.notes)}</textarea></label><div class="actions">${actions}</div></form>`;
}

function generateEquipmentNo() {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);
  return `VTCC-QR-${stamp}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}
function setEquipmentQr(value) {
  const input = document.querySelector("[name=equipment_no]");
  if (!input) return;
  input.value = value || input.value || generateEquipmentNo();
  const preview = document.querySelector("#qrPreview");
  if (preview) preview.innerHTML = qrSvg(input.value);
}
function readEquipmentDraft() {
  const form = document.querySelector("#equipmentForm");
  if (!form) return {};
  return formData(form);
}
function bindEquipmentForm() {
  const form = document.querySelector("#equipmentForm");
  form.onsubmit = saveEquipment;
  const starter = document.querySelector("#startEquipmentCreate");
  if (starter)
    starter.onclick = () => {
      state.equipmentMode = "create";
      state.editingEquipmentId = null;
      state.equipmentDraft = { equipment_no: generateEquipmentNo() };
      loadEquipment();
    };
  const cancel = document.querySelector("#cancelEquipment");
  if (cancel)
    cancel.onclick = () => {
      resetEquipmentMode();
      loadEquipment();
    };
  const generator = document.querySelector("#generateQr");
  if (generator)
    generator.onclick = () =>
      setEquipmentQr(document.querySelector("[name=equipment_no]")?.value);
  if (
    state.equipmentDraft?.equipment_no &&
    document.querySelector("#qrPreview")
  )
    document.querySelector("#qrPreview").innerHTML = qrSvg(
      state.equipmentDraft.equipment_no,
    );
}
async function editEquipment(id) {
  if (!can("equipment:update")) return;
  const [m, data] = await Promise.all([
    ensureMaster(),
    api(`/api/equipment/${id}`),
  ]);
  state.equipmentMode = "edit";
  state.editingEquipmentId = data.equipment.id;
  state.equipmentDraft = data.equipment;
  loadEquipment();
}
async function saveEquipment(event) {
  event.preventDefault();
  if (state.equipmentMode === "create" && !can("equipment:create")) return;
  if (state.equipmentMode === "edit" && !can("equipment:update")) return;
  if (state.equipmentMode === "idle") return;
  const code = event.target.elements.equipment_no;
  if (state.equipmentMode === "create" && code && !code.value)
    code.value = generateEquipmentNo();
  const data = formData(event.target);
  const id = state.equipmentMode === "edit" ? state.editingEquipmentId : "";
  delete data.id;
  await api(id ? `/api/equipment/${id}` : "/api/equipment", {
    method: id ? "PUT" : "POST",
    body: JSON.stringify(data),
  });
  resetEquipmentMode();
  state.master = null;
  await loadEquipment();
}
async function startScanner() {
  const area = document.querySelector("#scanArea"),
    video = document.querySelector("#reader");
  area.classList.remove("hidden");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
    });
    video.srcObject = stream;
    await video.play();
    if (!("BarcodeDetector" in window)) return;
    const detector = new BarcodeDetector({ formats: ["qr_code"] });
    const tick = async () => {
      if (!video.srcObject) return;
      const codes = await detector.detect(video);
      if (codes.length) {
        const value = codes[0].rawValue.trim();
        stream.getTracks().forEach((t) => t.stop());
        document.querySelector("#search").value = value;
        loadEquipment(value);
        return;
      }
      requestAnimationFrame(tick);
    };
    tick();
  } catch (err) {
    area.innerHTML = `<p class="message">${esc(err.message)}</p>`;
  }
}
function qrSvg(text) {
  let bits = [...text]
    .map((ch) => ch.charCodeAt(0).toString(2).padStart(8, "0"))
    .join("");
  let cells = "";
  for (let y = 0; y < 21; y++)
    for (let x = 0; x < 21; x++) {
      const finder = (x < 7 && y < 7) || (x > 13 && y < 7) || (x < 7 && y > 13);
      const on = finder
        ? x % 6 === 0 ||
          y % 6 === 0 ||
          (x > 1 && x < 5 && y > 1 && y < 5) ||
          (x > 15 && x < 19 && y > 1 && y < 5) ||
          (x > 1 && x < 5 && y > 15 && y < 19)
        : bits[(x * 13 + y * 7) % bits.length] === "1";
      if (on) cells += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
    }
  return `<div><svg viewBox="0 0 21 21" width="150" height="150" aria-label="QR marker"><rect width="21" height="21" fill="white"/><g fill="black">${cells}</g></svg></div>`;
}

function resetMasterMode() {
  state.masterMode = "idle";
  state.editingMasterId = null;
  state.masterDraft = {};
}
function masterConfig(kind) {
  return {
    categories: {
      title: "Category",
      number: "category_no",
      numberLabel: "Category no.",
      fields: ["category_no", "name"],
    },
    groups: {
      title: "Group",
      number: "group_no",
      numberLabel: "Group no.",
      fields: ["group_no", "name", "category_name"],
    },
    locations: {
      title: "Location Store",
      number: "locate_no",
      numberLabel: "Location Store no.",
      fields: ["locate_no", "name", "details"],
    },
  }[kind];
}
function masterForm(kind) {
  const config = masterConfig(kind);
  const item = state.masterDraft || {};
  const active = state.masterMode !== "idle";
  const disabled = active ? "" : "disabled";
  const actions = active
    ? '<button type="submit">Save</button><button type="button" class="secondary" id="cancelMaster">Cancel</button>'
    : '<button type="button" id="startMasterCreate">Create</button>';
  let extra = "";
  if (kind === "groups") {
    const categories = state.master.categories.filter(
      (category) => category.active || category.id === item.category_id,
    );
    extra = `<label>Category <select name="category_id" required ${disabled}>${optionRows(categories, "id", (category) => `${category.category_no} - ${category.name}`, item.category_id)}</select></label>`;
  } else if (kind === "locations") {
    extra = `<label>Location details <textarea name="details" ${disabled}>${esc(item.details)}</textarea></label>`;
  }
  return `<form id="masterForm" class="form-grid"><label>${config.numberLabel} <input name="${config.number}" value="${esc(item[config.number])}" disabled></label><label>Name <input name="name" required value="${esc(item.name)}" ${disabled}></label>${extra}<div class="actions">${actions}</div></form>`;
}
function masterTable(kind, items) {
  const config = masterConfig(kind);
  const busy = state.masterMode !== "idle";
  const headings = [
    ...config.fields.map((field) => `<th>${field.replaceAll("_", " ")}</th>`),
    "<th>Status</th>",
    "<th>Update</th>",
    "<th>Active</th>",
    "<th>Delete</th>",
  ].join("");
  const body = items
    .map(
      (item) =>
        `<tr>${config.fields.map((field) => `<td>${esc(item[field])}</td>`).join("")}<td><span class="badge ${item.active ? "ok" : ""}">${item.active ? "Active" : "Inactive"}</span></td><td><button class="secondary" data-edit-master="${item.id}" ${busy ? "disabled" : ""}>Update</button></td><td><button class="secondary" data-toggle-master="${item.id}" ${busy ? "disabled" : ""}>${item.active ? "Deactivate" : "Activate"}</button></td><td><button class="danger" data-delete-master="${item.id}" ${busy ? "disabled" : ""}>Delete</button></td></tr>`,
    )
    .join("");
  return `<div class="table-wrap"><table><thead><tr>${headings}</tr></thead><tbody>${body || '<tr><td colspan="8">No items found</td></tr>'}</tbody></table></div>`;
}
async function loadMaster(kind) {
  const data = await api("/api/master");
  state.master = data;
  const config = masterConfig(kind);
  const busy = state.masterMode !== "idle";
  content(
    config.title,
    `<section class="panel">${masterForm(kind)}</section><section class="panel space-top${busy ? " panel-disabled" : ""}" aria-disabled="${busy}">${masterTable(kind, data[kind])}</section>`,
  );
  document.querySelector("#masterForm").onsubmit = (event) =>
    saveMaster(event, kind);
  const create = document.querySelector("#startMasterCreate");
  if (create)
    create.onclick = () => {
      state.masterMode = "create";
      state.editingMasterId = null;
      state.masterDraft = { [config.number]: data.next_numbers[kind] };
      loadMaster(kind);
    };
  const cancel = document.querySelector("#cancelMaster");
  if (cancel)
    cancel.onclick = () => {
      resetMasterMode();
      loadMaster(kind);
    };
  document.querySelectorAll("[data-edit-master]").forEach(
    (button) =>
      (button.onclick = () => {
        if (state.masterMode !== "idle") return;
        const item = data[kind].find(
          (entry) => String(entry.id) === button.dataset.editMaster,
        );
        if (!item) return;
        state.masterMode = "edit";
        state.editingMasterId = item.id;
        state.masterDraft = item;
        loadMaster(kind);
      }),
  );
  document.querySelectorAll("[data-toggle-master]").forEach(
    (button) =>
      (button.onclick = async () => {
        if (state.masterMode !== "idle") return;
        const item = data[kind].find(
          (entry) => String(entry.id) === button.dataset.toggleMaster,
        );
        if (!item) return;
        await api(`/api/master/${kind}`, {
          method: "PUT",
          body: JSON.stringify({ id: item.id, active: item.active ? 0 : 1 }),
        });
        state.master = null;
        await loadMaster(kind);
      }),
  );
  document.querySelectorAll("[data-delete-master]").forEach(
    (button) =>
      (button.onclick = async () => {
        if (state.masterMode !== "idle") return;
        const item = data[kind].find(
          (entry) => String(entry.id) === button.dataset.deleteMaster,
        );
        if (!item || !confirm(`Delete ${item[config.number]} - ${item.name}?`))
          return;
        try {
          await api(`/api/master/${kind}`, {
            method: "DELETE",
            body: JSON.stringify({ id: item.id }),
          });
          state.master = null;
          await loadMaster(kind);
        } catch (error) {
          alert(error.message);
        }
      }),
  );
}
async function saveMaster(event, kind) {
  event.preventDefault();
  if (state.masterMode === "idle") return;
  const data = formData(event.target);
  const editing = state.masterMode === "edit";
  if (editing) data.id = state.editingMasterId;
  await api(`/api/master/${kind}`, {
    method: editing ? "PUT" : "POST",
    body: JSON.stringify(data),
  });
  resetMasterMode();
  state.master = null;
  await loadMaster(kind);
}

function orderForm(type) {
  const equipmentOptions = state.equipment
    .map((e) => `<option value="${e.id}">${esc(e.name)}</option>`)
    .join("");
  return `<section class="panel"><form id="orderForm" class="form-grid"><input name="order_type" type="hidden" value="${type}"><div class="grid-2"><label>Equipment <select name="equipment_id">${equipmentOptions}</select></label><label>Quantity <input name="quantity" type="number" min="1" value="1"></label></div><div class="grid-2"><label>${type === "purchase" ? "Purchase file reference" : "Purpose / reason"} <input name="purpose"></label><label>${type === "purchase" ? "Saved purchase file" : "Reference file"} <input name="file_reference"></label></div><button>Submit ${type}</button></form></section>`;
}
async function loadPurchase() {
  await ensureEquipment();
  content(
    "Purchase Orders",
    `${orderForm("purchase")}<section class="panel space-top"><h2>Purchase history</h2><div id="ordersTable"></div></section>`,
  );
  bindOrderForm("purchase");
  renderOrders("purchase");
}
async function loadOrders(type) {
  await ensureEquipment();
  const create =
    (type === "request" && can("request:create")) ||
    (type === "return" && can("return:create"));
  content(
    type === "request" ? "Request Orders" : "Return Orders",
    `${create ? orderForm(type) : ""}<section class="panel ${create ? "space-top" : ""}"><div id="ordersTable"></div></section>`,
  );
  if (create) bindOrderForm(type);
  renderOrders(type);
}
function bindOrderForm(type) {
  document.querySelector("#orderForm").onsubmit = async (event) => {
    event.preventDefault();
    const d = formData(event.target);
    await api("/api/orders", {
      method: "POST",
      body: JSON.stringify({
        order_type: type,
        purpose: d.purpose,
        file_reference: d.file_reference,
        items: [{ equipment_id: d.equipment_id, quantity: d.quantity }],
      }),
    });
    event.target.reset();
    renderOrders(type);
  };
}
async function renderOrders(type) {
  const data = await api(`/api/orders?type=${type}`);
  state.orders = data.orders;
  document.querySelector("#ordersTable").innerHTML = ordersTable(
    data.orders,
    type,
  );
  bindOrderActions(type);
}
function itemSummary(order) {
  return order.items.map((i) => `${esc(i.name)} x ${i.quantity}`).join("<br>");
}
function ordersTable(orders, type) {
  return `<table><thead><tr><th>ID</th><th>Items</th><th>Status</th><th>Requester</th><th>Dates</th><th>Comment</th><th>Actions</th></tr></thead><tbody>${orders.map((o) => `<tr><td>#${o.id}<br><span class="hint">${esc(o.file_reference || "")}</span></td><td>${itemSummary(o)}</td><td><span class="badge">${esc(o.status)}</span></td><td>${esc(o.requester_name)}</td><td><span class="hint">Created ${esc(o.created_at)}${o.acknowledged_at ? `<br>Ack ${esc(o.acknowledged_at)}` : ""}${o.decided_at ? `<br>Decide ${esc(o.decided_at)}` : ""}</span></td><td>${esc(o.comment || o.purpose || "")}</td><td class="actions">${orderButtons(o, type)}</td></tr>`).join("") || `<tr><td colspan="7">No ${type} orders yet</td></tr>`}</tbody></table>`;
}
function orderButtons(o, type) {
  let b = "";
  if (
    (type === "request" && can("request:manage")) ||
    (type === "return" && can("return:manage"))
  ) {
    if (o.status === "pending")
      b += `<button data-action="ack" data-id="${o.id}">Acknowledge</button>`;
    if (["pending", "acknowledged"].includes(o.status))
      b +=
        type === "request"
          ? `<button data-action="decide" data-decision="approved" data-id="${o.id}">Approve</button><button class="danger" data-action="decide" data-decision="rejected" data-id="${o.id}">Reject</button>`
          : `<button data-action="decide" data-decision="accepted" data-id="${o.id}">Accept</button><button class="danger" data-action="decide" data-decision="cancelled" data-id="${o.id}">Cancel</button>`;
    if (type === "request" && o.status === "approved")
      b += `<button data-action="store-deliver" data-id="${o.id}">Deliver items</button>`;
    if (type === "return" && o.status === "return_delivered")
      b += `<button data-action="store-receive" data-return-action="stock" data-id="${o.id}">Get to stock</button><button class="danger" data-action="store-receive" data-return-action="purge" data-id="${o.id}">Purge</button>`;
  }
  if (state.user.id === o.requester_id) {
    if (type === "request" && o.status === "delivered")
      b += `<button data-action="requester-accept" data-id="${o.id}">Accept delivered</button>`;
    if (type === "return" && o.status === "accepted")
      b += `<button data-action="returner-deliver" data-id="${o.id}">Deliver to store</button>`;
  }
  return b || `<span class="hint">No action</span>`;
}
function bindOrderActions(type) {
  document.querySelectorAll("[data-action]").forEach(
    (btn) =>
      (btn.onclick = async () => {
        const body = {};
        if (btn.dataset.decision) body.decision = btn.dataset.decision;
        if (btn.dataset.action === "decide")
          body.comment = prompt("Comment", "") || "";
        if (btn.dataset.returnAction)
          body.return_action = btn.dataset.returnAction;
        await api(`/api/orders/${btn.dataset.id}/${btn.dataset.action}`, {
          method: "PUT",
          body: JSON.stringify(body),
        });
        renderOrders(type);
      }),
  );
}

async function loadNotifications() {
  const data = await api("/api/notifications");
  content(
    "Notifications",
    `<section class="panel"><table><thead><tr><th>Time</th><th>Message</th><th>Status</th></tr></thead><tbody>${data.notifications.map((n) => `<tr><td>${esc(n.created_at)}</td><td>${esc(n.message)}</td><td>${n.read_at ? "Read" : "New"}</td></tr>`).join("") || `<tr><td colspan="3">No notifications</td></tr>`}</tbody></table></section>`,
  );
}
function resetUserMode() {
  state.userMode = "idle";
  state.editingUserId = null;
  state.userDraft = {};
}
function userForm() {
  const active = state.userMode !== "idle";
  const editing = state.userMode === "edit";
  const user = state.userDraft;
  const disabled = active ? "" : "disabled";
  const actions = active
    ? `<button type="submit">Save</button><button type="button" class="secondary" id="cancelUser">Cancel</button>`
    : `<button type="button" id="startUserCreate">Create</button>`;
  return `<form id="userForm" class="form-grid"><input name="active" type="hidden" value="${user.active ?? 1}"><div class="grid-2"><label>Username <input name="username" required value="${esc(user.username)}" ${disabled}></label><label>Full name <input name="full_name" required value="${esc(user.full_name)}" ${disabled}></label></div><div class="grid-2"><label>Password <input name="password" type="password" ${editing ? "" : "required"} ${disabled} placeholder="${editing ? "Leave blank to keep current password" : ""}"></label><label>Role <select name="role" ${disabled}>${Object.entries(
    roleLabels,
  )
    .map(
      ([key, label]) =>
        `<option value="${key}" ${user.role === key ? "selected" : ""}>${label}</option>`,
    )
    .join(
      "",
    )}</select></label></div><div class="actions">${actions}</div></form>`;
}
function usersTable(users) {
  const busy = state.userMode !== "idle";
  return `<table><thead><tr><th>User</th><th>Name</th><th>Role</th><th>Status</th><th>Update</th><th>Active</th><th>Delete</th></tr></thead><tbody>${users.map((user) => `<tr><td>${esc(user.username)}</td><td>${esc(user.full_name)}</td><td>${esc(roleLabels[user.role])}</td><td><span class="badge ${user.active ? "ok" : ""}">${user.active ? "Active" : "Inactive"}</span></td><td><button class="secondary" data-update-user="${user.id}" ${busy ? "disabled" : ""}>Update</button></td><td><button class="secondary" data-toggle-user="${user.id}" ${busy ? "disabled" : ""}>${user.active ? "Deactivate" : "Activate"}</button></td><td><button class="danger" data-delete-user="${user.id}" ${busy ? "disabled" : ""}>Delete</button></td></tr>`).join("") || `<tr><td colspan="7">No users found</td></tr>`}</tbody></table>`;
}
async function loadUsers() {
  const data = await api("/api/users");
  const busy = state.userMode !== "idle";
  content(
    "Manage User and Role",
    `<section class="panel">${userForm()}</section><section class="panel space-top${busy ? " panel-disabled" : ""}" aria-disabled="${busy}">${usersTable(data.users)}</section>`,
  );
  document.querySelector("#userForm").onsubmit = saveUser;
  const create = document.querySelector("#startUserCreate");
  if (create)
    create.onclick = () => {
      state.userMode = "create";
      state.editingUserId = null;
      state.userDraft = {};
      loadUsers();
    };
  const cancel = document.querySelector("#cancelUser");
  if (cancel)
    cancel.onclick = () => {
      resetUserMode();
      loadUsers();
    };
  document.querySelectorAll("[data-update-user]").forEach(
    (button) =>
      (button.onclick = () => {
        const user = data.users.find(
          (item) => String(item.id) === button.dataset.updateUser,
        );
        if (!user || state.userMode !== "idle") return;
        state.userMode = "edit";
        state.editingUserId = user.id;
        state.userDraft = user;
        loadUsers();
      }),
  );
  document.querySelectorAll("[data-toggle-user]").forEach(
    (button) =>
      (button.onclick = async () => {
        if (state.userMode !== "idle") return;
        const user = data.users.find(
          (item) => String(item.id) === button.dataset.toggleUser,
        );
        if (!user) return;
        try {
          await api(`/api/users/${user.id}`, {
            method: "PUT",
            body: JSON.stringify({ active: user.active ? 0 : 1 }),
          });
          await loadUsers();
        } catch (error) {
          alert(error.message);
        }
      }),
  );
  document.querySelectorAll("[data-delete-user]").forEach(
    (button) =>
      (button.onclick = async () => {
        if (state.userMode !== "idle") return;
        const user = data.users.find(
          (item) => String(item.id) === button.dataset.deleteUser,
        );
        if (!user || !confirm(`Delete user ${user.username}?`)) return;
        try {
          await api(`/api/users/${user.id}`, { method: "DELETE" });
          await loadUsers();
        } catch (error) {
          alert(error.message);
        }
      }),
  );
}
async function saveUser(event) {
  event.preventDefault();
  if (state.userMode === "idle") return;
  const data = formData(event.target);
  const editing = state.userMode === "edit";
  await api(editing ? `/api/users/${state.editingUserId}` : "/api/users", {
    method: editing ? "PUT" : "POST",
    body: JSON.stringify(data),
  });
  resetUserMode();
  await loadUsers();
}
async function loadSyslog() {
  const data = await api("/api/syslog");
  content(
    "See Syslog",
    `<section class="panel"><table><thead><tr><th>UTC Time</th><th>Local Time</th><th>User</th><th>Action</th><th>Entity</th><th>Details</th></tr></thead><tbody>${data.syslog.map((s) => `<tr><td>${esc(s.created_at)}</td><td>${esc(localTime(s.created_at))}</td><td>${esc(s.username || "system")}</td><td>${esc(s.action)}</td><td>${esc(s.entity_type)} #${s.entity_id || ""}</td><td>${esc(s.details)}</td></tr>`).join("") || `<tr><td colspan="6">No syslog entries yet</td></tr>`}</tbody></table></section>`,
  );
}
async function boot() {
  const data = await api("/api/me");
  state.user = data.user;
  if (!state.user) return renderLogin();
  state.view = defaultView();
  renderShell();
}
boot().catch((err) => renderLogin(err.message));
