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
  front_end: "Front-End",
  store_manager: "Store Manager",
  store: "Store Officer",
};
const rules = {
  front_end: [
    "request:create",
    "return:create",
    "inventory:read",
    "notifications:read",
    "dashboard:read",
  ],
  store_manager: [
    "master:manage",
    "equipment:create",
    "equipment:update",
    "orders:read",
    "inventory:read",
    "dashboard:read",
    "request:final_approve",
    "return:final_approve",
    "movement:approve",
    "audit:read",
    "notifications:read",
  ],
  store: [
    "inventory:read",
    "purchase:create",
    "request:prepare",
    "return:receive",
    "return:inspect",
    "movement:propose",
    "orders:read",
    "dashboard:read",
    "notifications:read",
  ],
};
function hasRole(role) {
  return (state.user?.roles || [state.user?.role]).includes(role);
}
function can(permission) {
  return (
    state.user &&
    (hasRole("administrator") ||
      (state.user.roles || [state.user.role]).some((role) =>
        (rules[role] || []).includes(permission),
      ))
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
  return "dashboard";
}
function navItems() {
  if (hasRole("administrator"))
    return [
      ["dashboard", "System Overview", true],
      ["users", "Users & Roles", true, "administration"],
      ["syslog", "Syslog", true, "administration"],
    ];
  const items = [["dashboard", "Overview", true]];
  if (hasRole("store_manager"))
    items.push(
      ["approvals", "Approval Center", true, "work"],
      ["equipment-manage", "Equipment Master", true, "equipment"],
      ["equipment-current", "Current Equipment", true, "equipment"],
      ["returned-goods", "Returned Goods", true, "operations"],
      ["categories", "Catalogs", true, "configuration"],
      ["groups", "Groups", true, "configuration"],
      ["locations", "Locations", true, "configuration"],
      ["officer-activity", "Officer Activity", true, "monitoring"],
    );
  if (hasRole("store"))
    items.push(
      ["operations", "Operations Queue", true, "work"],
      ["equipment-current", "Current Equipment", true, "equipment"],
      ["equipment-in-procurement", "Procurement", true, "incoming"],
      ["equipment-in-return", "Return Equipment", true, "incoming"],
      ["equipment-in-check", "Checking Store", true, "incoming"],
      ["equipment-out-delivery", "Delivered Requests", true, "outgoing"],
      ["equipment-out-check", "Checking Store", true, "outgoing"],
      ["returned-goods", "Returned Goods", true, "operations"],
    );
  if (hasRole("front_end"))
    items.push(
      ["equipment-current", "My Equipment", true, "equipment"],
      ["requests", "Request Equipment", true, "transactions"],
      ["returns", "Return Equipment", true, "transactions"],
    );
  items.push(["notifications", "Notifications", true]);
  return items;
}
function renderNavigation(items) {
  let lastSection = "";
  const headings = {
    administration: "Administration",
    work: "Work Queue",
    equipment: "Equipment",
    incoming: "Incoming Equipment",
    outgoing: "Outgoing Equipment",
    operations: "Operations",
    configuration: "Basic Configuration",
    monitoring: "Monitoring",
    transactions: "My Transactions",
  };
  return items
    .map(([id, label, , section]) => {
      const heading =
        section && section !== lastSection
          ? `<div class="nav-group-label">${headings[section]}</div>`
          : "";
      lastSection = section || "";
      return `${heading}<button data-view="${id}" class="${state.view === id ? "active" : ""} ${section ? "nav-subitem" : ""}">${label}</button>`;
    })
    .join("");
}
function renderShell() {
  app.className = "shell";
  const items = navItems();
  if (!items.some(([id]) => id === state.view))
    state.view = items[0]?.[0] || defaultView();
  app.innerHTML = `<aside class="sidebar" id="sidebar"><div class="brand"><button id="menuToggle" class="icon-btn" title="Toggle menu">Menu</button><span>VTCC Store Inventory</span></div><div class="role">${esc(state.user.full_name)}<br>${(state.user.roles || [state.user.role]).map((role) => roleLabels[role]).join(" / ")}</div><nav class="nav">${renderNavigation(items)}<button id="logout">Log out</button></nav></aside><section class="content" id="content"></section>`;
  document.querySelector("#menuToggle").onclick = () =>
    document.querySelector("#sidebar").classList.toggle("collapsed");
  document.querySelectorAll("[data-view]").forEach(
    (btn) =>
      (btn.onclick = () => {
        resetMasterMode();
        resetEquipmentMode();
        state.view = btn.dataset.view;
        renderShell();
      }),
  );
  document.querySelector("#logout").onclick = async () => {
    await api("/api/logout", { method: "POST" });
    state.user = null;
    renderLogin();
  };
  const loaders = {
    dashboard: loadDashboard,
    approvals: loadApprovalCenter,
    operations: loadOperationsQueue,
    "equipment-manage": () => loadEquipment("", true),
    "equipment-current": () => loadEquipment("", false),
    "equipment-in-procurement": () => loadMovementScreen("procurement"),
    "equipment-in-return": () => loadReturnedGoods("restock"),
    "equipment-in-check": () =>
      loadMovementScreen("checking_store", "incoming"),
    "equipment-out-delivery": () =>
      loadOrders("request", "Outgoing Equipment - Delivered Requests"),
    "equipment-out-check": () =>
      loadMovementScreen("checking_store", "outgoing"),
    "returned-goods": () => loadReturnedGoods(),
    categories: () => loadMaster("categories"),
    groups: () => loadMaster("groups"),
    locations: () => loadMaster("locations"),
    requests: () => loadOrders("request"),
    returns: () => loadOrders("return"),
    notifications: loadNotifications,
    users: loadUsers,
    syslog: loadSyslog,
    "officer-activity": loadOfficerActivity,
  };
  (loaders[state.view] || loadEquipment)();
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
  return `<table><thead><tr><th>Equipment</th><th>Category</th><th>Group / Default location</th><th>Total quantity</th><th>Status</th><th>Trace / Edit</th></tr></thead><tbody>${items.map((item) => `<tr><td><b>${esc(item.equipment_no)}</b><br>${esc(item.name)}</td><td>${esc(item.category_name || item.category)}</td><td>${esc(item.group_name || "-")}<br><span class="hint">${esc(item.location_name || item.location)}</span></td><td>${item.quantity} ${esc(item.unit)}</td><td>${stockBadge(item)}</td><td class="actions"><button class="secondary" data-trace="${item.id}">Trace</button>${actions ? `<button class="secondary" data-edit="${item.id}" ${equipmentBusy() ? "disabled" : ""}>Edit details</button>` : ""}</td></tr>`).join("") || `<tr><td colspan="6">No equipment found</td></tr>`}</tbody></table>`;
}
async function loadEquipment(q = "", manage = false) {
  const [m, data] = await Promise.all([
    ensureMaster(),
    api(`/api/equipment?q=${encodeURIComponent(q)}`),
  ]);
  state.equipment = data.equipment;
  const draft = state.equipmentDraft || {};
  const equipmentTools = hasRole("front_end")
    ? `<button id="requestEquipment">Request</button><button id="returnEquipment" class="secondary">Return</button>`
    : "";
  content(
    manage ? "Equipment manage" : "Current equipment",
    `<p class="hint">Equipment identity and details are maintained here. Quantities can only change through Incoming equipment or Outgoing equipment.</p><div class="inventory-layout"><section class="panel"><div class="toolbar"><input id="search" placeholder="Search equipment or scan QR code"><button id="searchBtn" class="secondary">Search</button><button id="scanBtn" class="secondary">Scan QR</button></div><div id="scanArea" class="hidden"><div id="reader"></div></div><div class="table-wrap">${equipmentTable(data.equipment, manage)}</div><div id="tracePanel"></div></section><section class="panel"><h2>Equipment details</h2>${equipmentForm(draft, m, manage)}<div id="qrPreview" class="qr-box">
    ${draft.equipment_no ? "" : "QR-Code will show after generation"}</div></section></div>`,
    equipmentTools,
  );
  const requestButton = document.querySelector("#requestEquipment");
  if (requestButton)
    requestButton.onclick = () => {
      state.view = "requests";
      renderShell();
    };
  const returnButton = document.querySelector("#returnEquipment");
  if (returnButton)
    returnButton.onclick = () => {
      state.view = "returns";
      renderShell();
    };
  document.querySelector("#searchBtn").onclick = () =>
    loadEquipment(document.querySelector("#search").value, manage);
  document.querySelector("#search").onkeydown = (e) => {
    if (e.key === "Enter") loadEquipment(e.target.value, manage);
  };

  /*
  document.querySelector("#scanBtn").onclick = () =>
    startScanner((value) => loadEquipment(value, manage));
 */
  document.querySelector("#scanBtn").onclick = () =>
    startScanner((value) =>
      loadEquipment(parseEquipmentNoFromQr(value), manage),
    );

  document
    .querySelectorAll("[data-edit]")
    .forEach((btn) => (btn.onclick = () => editEquipment(btn.dataset.edit)));
  document
    .querySelectorAll("[data-trace]")
    .forEach(
      (btn) => (btn.onclick = () => showEquipmentTrace(btn.dataset.trace)),
    );
  bindEquipmentForm();
  if (draft.equipment_no) setEquipmentQr(draft.equipment_no);
}

function equipmentForm(item = {}, m = state.master, editable = false) {
  const active = equipmentBusy(),
    createMode = state.equipmentMode === "create",
    editMode = state.equipmentMode === "edit";
  const canSave =
    editable &&
    ((createMode && can("equipment:create")) ||
      (editMode && can("equipment:update")));
  const disabled = canSave ? "" : "disabled";
  const qrButton = `<button type="button" class="secondary" id="generateQr" ${active ? "" : "disabled"}>Generate QR-Code</button>`;
  const actions = active
    ? `<button type="submit">Save details</button><button type="button" class="secondary" id="cancelEquipment">Cancel</button>`
    : editable && can("equipment:create")
      ? `<button type="button" id="startEquipmentCreate">Create equipment</button>`
      : `<span class="hint">Select an equipment item.</span>`;
  return `<form id="equipmentForm" class="form-grid"><label>Unique equipment no. <span class="unique-row"><input name="equipment_no" required value="${esc(item.equipment_no)}" ${disabled}>${qrButton}</span></label><label>Name <input name="name" required value="${esc(item.name)}" ${disabled}></label><div class="grid-2"><label>Category <select name="category_id" required ${disabled}>${optionRows(
    m.categories.filter((x) => x.active || x.id === item.category_id),
    "id",
    (x) => `${x.category_no} - ${x.name}`,
    item.category_id,
  )}</select></label><label>Group <select name="group_id" ${disabled}><option value="">None</option>${optionRows(
    m.groups.filter((x) => x.active || x.id === item.group_id),
    "id",
    (x) => `${x.group_no} - ${x.name}`,
    item.group_id,
  )}</select></label></div><label>Default location <select name="location_id" required ${disabled}>${optionRows(
    m.locations.filter((x) => x.active || x.id === item.location_id),
    "id",
    (x) => `${x.locate_no} - ${x.name}`,
    item.location_id,
  )}</select></label><div class="grid-2"><label>Unit <input name="unit" value="${esc(item.unit || "pcs")}" ${disabled}></label><label>Current quantity <input value="${item.quantity || 0}" disabled></label></div><div class="grid-2"><label>Minimum <input name="minimum_qty" type="number" min="0" value="${item.minimum_qty || 0}" ${disabled}></label><label>Maximum <input name="maximum_qty" type="number" min="0" value="${item.maximum_qty || 0}" ${disabled}></label></div><label>Status <select name="status" ${disabled}><option ${item.status === "available" ? "selected" : ""}>available</option><option ${item.status === "maintenance" ? "selected" : ""}>maintenance</option><option ${item.status === "retired" ? "selected" : ""}>retired</option></select></label><label>Detail <textarea name="notes" ${disabled}>${esc(item.notes)}</textarea></label><div class="actions">${actions}</div></form>`;
}
function generateEquipmentNo() {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);
  return `VTCC-QR-${stamp}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

/*
function setEquipmentQr(value) {
  const input = document.querySelector("[name=equipment_no]");
  if (!input) return;
  input.value = value || input.value || generateEquipmentNo();
  const preview = document.querySelector("#qrPreview");
  if (preview) preview.innerHTML = qrSvg(input.value);
}
*/

function setEquipmentQr(value) {
  const input = document.querySelector("[name=equipment_no]");
  if (!input) return;

  input.value = value || input.value || generateEquipmentNo();

  const preview = document.querySelector("#qrPreview");
  if (!preview) return;

  preview.innerHTML = "";

  new QRCode(preview, {
    text: input.value,
    width: 180,
    height: 180,
    correctLevel: QRCode.CorrectLevel.H,
  });
}

function bindEquipmentForm() {
  const form = document.querySelector("#equipmentForm");
  form.onsubmit = saveEquipment;
  const starter = document.querySelector("#startEquipmentCreate");
  if (starter)
    starter.onclick = () => {
      state.equipmentMode = "create";
      state.equipmentDraft = { equipment_no: generateEquipmentNo() };
      loadEquipment("", true);
    };
  const cancel = document.querySelector("#cancelEquipment");
  if (cancel)
    cancel.onclick = () => {
      resetEquipmentMode();
      loadEquipment("", true);
    };
  const generator = document.querySelector("#generateQr");
  if (generator)
    generator.onclick = () =>
      setEquipmentQr(document.querySelector("[name=equipment_no]")?.value);
}
async function editEquipment(id) {
  if (!can("equipment:update") || equipmentBusy()) return;
  const data = await api(`/api/equipment/${id}`);
  state.equipmentMode = "edit";
  state.editingEquipmentId = data.equipment.id;
  state.equipmentDraft = data.equipment;
  loadEquipment("", true);
}
async function saveEquipment(event) {
  event.preventDefault();
  if (state.equipmentMode === "idle") return;
  const code = event.target.elements.equipment_no;
  if (!code.value) code.value = generateEquipmentNo();
  const data = formData(event.target);
  const id = state.equipmentMode === "edit" ? state.editingEquipmentId : "";
  await api(id ? `/api/equipment/${id}` : "/api/equipment", {
    method: id ? "PUT" : "POST",
    body: JSON.stringify(data),
  });
  resetEquipmentMode();
  state.master = null;
  await loadEquipment("", true);
}
function balanceTable(items) {
  return `<div class="table-wrap"><table><thead><tr><th>Storage location</th><th>Incoming source</th><th>Lot / count reference</th><th>Available quantity</th></tr></thead><tbody>${items.map((b) => `<tr><td><b>${esc(b.locate_no)}</b><br>${esc(b.location_name)}</td><td>${esc(movementLabels[b.source_type] || b.source_type)}</td><td>${esc(b.lot_reference)}</td><td><b>${b.quantity}</b> ${esc(b.unit)}</td></tr>`).join("") || `<tr><td colspan="4">No quantity is currently stored</td></tr>`}</tbody></table></div>`;
}
async function showEquipmentTrace(id) {
  const [item, balances, history] = await Promise.all([
    api(`/api/equipment/${id}`),
    api(`/api/stock-balances?equipment_id=${id}`),
    api(`/api/stock-movements?equipment_id=${id}`),
  ]);
  const panel = document.querySelector("#tracePanel");
  panel.innerHTML = `<section class="trace-panel"><h2>Stored quantity: ${esc(item.equipment.equipment_no)} - ${esc(item.equipment.name)}</h2>${balanceTable(balances.balances)}<h2 class="space-top">Movement trace</h2>${movementTable(history.movements)}</section>`;
  panel.scrollIntoView({ behavior: "smooth" });
}
const movementLabels = {
  procurement: "Procurement",
  return_equipment: "From Return equipment",
  checking_store: "From Checking Store",
  delivered_requester: "Delivered to requester",
  purchase: "Procurement",
  return_stock: "From Return equipment",
  request_delivery: "Delivered to requester",
  store_check: "From Checking Store",
  opening_balance: "Opening balance",
  legacy_adjustment: "Legacy workflow",
};
function movementTable(items) {
  return `<div class="table-wrap"><table><thead><tr><th>Time</th><th>Equipment</th><th>Location / Lot</th><th>Source</th><th>Change</th><th>Location balance</th><th>Total balance</th><th>Reference / Officer</th></tr></thead><tbody>${items.map((m) => `<tr><td>${esc(localTime(m.created_at))}</td><td><b>${esc(m.equipment_no)}</b><br>${esc(m.name)}</td><td>${m.location_name ? `<b>${esc(m.locate_no)}</b><br>${esc(m.location_name)}<br><span class="hint">Lot: ${esc(m.lot_reference || "-")}</span>` : "Legacy record"}</td><td>${esc(movementLabels[m.source_type || m.movement_type] || m.movement_type)}</td><td class="${m.quantity > 0 ? "qty-in" : m.quantity < 0 ? "qty-out" : ""}">${m.quantity > 0 ? "+" : ""}${m.quantity} ${esc(m.unit)}</td><td>${m.location_quantity ?? "-"} → ${m.location_balance_after ?? "-"}</td><td>${m.system_quantity ?? "-"} → ${m.balance_after ?? "-"}</td><td>${esc(m.reference || "-")}<br><span class="hint">${esc(m.full_name)}</span></td></tr>`).join("") || `<tr><td colspan="8">No stock movements found</td></tr>`}</tbody></table></div>`;
}
function movementConfig(source, direction) {
  if (source === "procurement")
    return {
      title: "Incoming equipment - Procurement",
      direction: "incoming",
      help: "Record each procurement lot at its actual storage location.",
    };
  if (source === "return_equipment")
    return {
      title: "Incoming equipment - From Return equipment",
      direction: "incoming",
      help: "Record returned equipment at the location where it is placed.",
    };
  if (source === "delivered_requester")
    return {
      title: "Outgoing equipment - Delivered to requester",
      direction: "outgoing",
      help: "Select the exact stored location and incoming lot being issued.",
    };
  return {
    title: `${direction === "outgoing" ? "Outgoing" : "Incoming"} equipment - From Checking Store`,
    direction,
    help: "Select a location, count or scan the equipment there, and enter its actual location quantity.",
  };
}
async function loadMovementScreen(source, direction = "") {
  const config = movementConfig(source, direction);
  const [equipment, master, balances, history] = await Promise.all([
    ensureEquipment(),
    ensureMaster(),
    api("/api/stock-balances"),
    api(
      `/api/stock-movements?direction=${config.direction}&source_type=${source}`,
    ),
  ]);
  const checking = source === "checking_store",
    outgoing = source === "delivered_requester";
  const activeLocations = master.locations.filter((l) => l.active);
  const equipmentField = `<label class="grow">Equipment <select name="equipment_id" required>${optionRows(equipment, "id", (e) => `${e.equipment_no} - ${e.name} (total: ${e.quantity})`)}</select></label>`;
  const locationField = `<label>Storage location <select name="location_id" required>${optionRows(activeLocations, "id", (l) => `${l.locate_no} - ${l.name}`)}</select></label>`;
  const allocationField = `<label class="grow">Stored location / incoming lot <select name="allocation_id" required>${balances.balances.map((b) => `<option value="${b.id}" data-equipment="${b.equipment_id}" data-location="${b.location_id}">${esc(`${b.equipment_no} - ${b.equipment_name} | ${b.locate_no} - ${b.location_name} | ${movementLabels[b.source_type] || b.source_type}: ${b.lot_reference} | available ${b.quantity}`)}</option>`).join("")}</select></label><input name="equipment_id" type="hidden"><input name="location_id" type="hidden">`;
  const lotField =
    source === "procurement"
      ? `<label>Procurement lot <input name="lot_reference" required placeholder="Purchase order / procurement lot number"></label>`
      : !outgoing
        ? `<label>Lot / count reference <input name="lot_reference" placeholder="Optional identifying lot or count number"></label>`
        : "";
  content(
    config.title,
    `<section class="panel compact"><p class="hint">${config.help}</p><form id="movementForm" class="form-grid"><div class="toolbar">${outgoing ? allocationField : equipmentField}${checking ? `<button type="button" class="secondary" id="movementScan">Scan QR</button>` : ""}</div>${outgoing ? "" : locationField}<div id="scanArea" class="hidden"><video id="reader" muted playsinline></video></div>${checking ? `<div class="check-summary"><span>System quantity at location <b id="systemQty">0</b></span><span>Actual counted at location <input name="actual_quantity" type="number" min="0" required value="0"></span><span>Difference <b id="differenceQty">0</b></span></div>` : `<label>Quantity <input name="quantity" type="number" min="1" required value="1"></label>`}${lotField}<label>Reference / note <input name="reference" placeholder="Document, request, return, or count reference"></label><button>Record ${config.direction} quantity</button></form></section><section class="panel"><h2>${config.title} history</h2><div id="movementHistory">${movementTable(history.movements)}</div></section>`,
  );
  const form = document.querySelector("#movementForm");
  const updateAllocation = () => {
    if (!outgoing) return;
    const option = form.elements.allocation_id.selectedOptions[0];
    form.elements.equipment_id.value = option?.dataset.equipment || "";
    form.elements.location_id.value = option?.dataset.location || "";
  };
  const locationStock = () =>
    balances.balances
      .filter(
        (b) =>
          String(b.equipment_id) === String(form.elements.equipment_id.value) &&
          String(b.location_id) === String(form.elements.location_id.value),
      )
      .reduce((sum, b) => sum + Number(b.quantity), 0);
  const updateDifference = () => {
    if (!checking) return;
    const system = locationStock(),
      actual = Number(form.elements.actual_quantity.value || 0),
      difference = actual - system;
    document.querySelector("#systemQty").textContent = system;
    const output = document.querySelector("#differenceQty");
    output.textContent = `${difference > 0 ? "+" : ""}${difference}`;
    output.className =
      difference > 0 ? "qty-in" : difference < 0 ? "qty-out" : "";
  };
  if (outgoing) {
    form.elements.allocation_id.onchange = updateAllocation;
    updateAllocation();
  }
  if (checking) {
    form.elements.equipment_id.onchange = updateDifference;
    form.elements.location_id.onchange = updateDifference;
    form.elements.actual_quantity.oninput = updateDifference;
    document.querySelector("#movementScan").onclick = () =>
      startScanner((value) => {
        //const item = state.equipment.find((e) => e.equipment_no === value);
        const equipmentNo = parseEquipmentNoFromQr(value);
        const item = state.equipment.find(
          (e) => e.equipment_no === equipmentNo,
        );
        if (!item) return alert("Equipment QR code was not found");
        form.elements.equipment_id.value = item.id;
        updateDifference();
      });
    updateDifference();
  }
  form.onsubmit = async (event) => {
    event.preventDefault();
    const body = {
      ...formData(form),
      source_type: source,
      expected_direction: checking ? config.direction : "",
    };
    const result = await api("/api/stock-movements", {
      method: "POST",
      body: JSON.stringify(body),
    });
    alert(`Stock proposal #${result.id} was submitted to the Store Manager.`);
    await loadMovementScreen(source, direction);
  };
}

/*
function parseEquipmentNoFromQr(value) {
  const text = String(value || "").trim();

  if (text.startsWith("VTCC-EQ:")) {
    return text.replace("VTCC-EQ:", "").trim();
  }

  return text;
}
*/

function parseEquipmentNoFromQr(value) {
  return String(value || "")
    .trim()
    .replace(/^VTCC-EQ:/, "");
}

let activeScanner = null;

async function startScanner(onValue) {
  const area = document.querySelector("#scanArea");
  if (!area) return;

  area.classList.remove("hidden");
  area.innerHTML = `<div id="reader"></div>`;

  if (typeof Html5Qrcode === "undefined") {
    area.innerHTML = `<p class="message">html5-qrcode.min.js is not loaded.</p>`;
    return;
  }

  try {
    if (activeScanner) {
      await activeScanner.stop().catch(() => {});
      activeScanner.clear();
    }

    activeScanner = new Html5Qrcode("reader");

    await activeScanner.start(
      { facingMode: "environment" },
      {
        fps: 10,
        qrbox: { width: 250, height: 250 },
      },
      async (decodedText) => {
        const value = parseEquipmentNoFromQr(decodedText);

        await activeScanner.stop().catch(() => {});
        activeScanner.clear();
        activeScanner = null;

        area.classList.add("hidden");
        onValue(value);
      },
      () => {},
    );
  } catch (err) {
    area.innerHTML = `<p class="message">${esc(err.message || err)}</p>`;
  }
}

/*
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
*/

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
async function loadOrders(type, title = "") {
  await ensureEquipment();
  const create =
    (type === "request" && can("request:create")) ||
    (type === "return" && can("return:create"));
  content(
    title || (type === "request" ? "Request" : "Return"),
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
const statusLabels = {
  pending: "Submitted",
  pending_manager_approval: "Waiting for Manager",
  pending_manager_acceptance: "Waiting for Manager",
  manager_approved: "Manager Approved",
  manager_accepted: "Manager Accepted",
  delivered: "Delivered",
  return_delivered: "Delivered to Store",
  returned_goods: "In Returned Goods",
  completed: "Completed",
  rejected: "Rejected",
  cancelled: "Cancelled",
  pending_manager: "Waiting for Manager",
  approved_posted: "Approved & Posted",
  awaiting_inspection: "Awaiting Inspection",
  pending_manager_restock: "Restock Approval",
  pending_manager_discontinue: "Discontinue Approval",
  in_stock: "In Stock",
  discontinued: "Discontinued",
};
function statusBadge(status) {
  const tone = [
    "completed",
    "approved_posted",
    "in_stock",
    "manager_approved",
    "manager_accepted",
  ].includes(status)
    ? "ok"
    : ["rejected", "cancelled", "discontinued"].includes(status)
      ? "critical"
      : status.startsWith("pending") || status === "awaiting_inspection"
        ? "warning"
        : "";
  return `<span class="badge ${tone}">${esc(statusLabels[status] || status.replaceAll("_", " "))}</span>`;
}
function orderButtons(o, type) {
  let buttons = "";
  if (hasRole("store") && o.status === "pending")
    buttons += `<button data-action="prepare" data-id="${o.id}">${type === "request" ? "Prepare Request" : "Assign Return Area"}</button>`;
  const managerPending =
    type === "request"
      ? "pending_manager_approval"
      : "pending_manager_acceptance";
  if (hasRole("store_manager") && o.status === managerPending) {
    const approve = type === "request" ? "approved" : "accepted";
    const reject = type === "request" ? "rejected" : "cancelled";
    buttons += `<button data-action="decide" data-decision="${approve}" data-id="${o.id}">Approve</button><button class="danger" data-action="decide" data-decision="${reject}" data-id="${o.id}">Reject</button>`;
  }
  if (hasRole("store") && type === "request" && o.status === "manager_approved")
    buttons += `<button data-action="store-deliver" data-id="${o.id}">Deliver Items</button>`;
  if (hasRole("store") && type === "return" && o.status === "return_delivered")
    buttons += `<button data-action="store-receive" data-id="${o.id}">Receive into Returned Goods</button>`;
  if (state.user.id === o.requester_id) {
    if (o.status === "pending")
      buttons += `<button class="secondary" data-action="edit" data-id="${o.id}">Edit</button><button class="danger" data-action="delete" data-id="${o.id}">Delete</button>`;
    if (type === "request" && o.status === "delivered")
      buttons += `<button data-action="requester-accept" data-id="${o.id}">Confirm Receipt</button>`;
    if (type === "return" && o.status === "manager_accepted")
      buttons += `<button data-action="returner-deliver" data-id="${o.id}">Deliver to Store</button>`;
  }
  return buttons || '<span class="hint">No action required</span>';
}
function ordersTable(orders, type) {
  return `<div class="table-wrap"><table><thead><tr><th>Transaction</th><th>Items</th><th>Workflow Status</th><th>Requester</th><th>Activity</th><th>Purpose / Comment</th><th>Available Actions</th></tr></thead><tbody>${orders.map((o) => `<tr><td><b>#${o.id}</b><br><span class="hint">${esc(o.file_reference || type)}</span></td><td>${itemSummary(o)}</td><td>${statusBadge(o.status)}</td><td>${esc(o.requester_name)}</td><td><span class="hint">Submitted ${esc(localTime(o.created_at))}${o.authorizer_name ? `<br>Officer: ${esc(o.authorizer_name)}` : ""}${o.decider_name ? `<br>Manager: ${esc(o.decider_name)}` : ""}</span></td><td>${esc(o.comment || o.purpose || "-")}</td><td class="actions">${orderButtons(o, type)}</td></tr>`).join("") || `<tr><td colspan="7">No ${type} transactions</td></tr>`}</tbody></table></div>`;
}
function bindOrderActions(type) {
  document.querySelectorAll("[data-action]").forEach(
    (btn) =>
      (btn.onclick = async () => {
        const order = state.orders.find(
          (item) => String(item.id) === btn.dataset.id,
        );
        if (btn.dataset.action === "delete") {
          if (!confirm(`Delete ${type} #${btn.dataset.id}?`)) return;
          await api(`/api/orders/${btn.dataset.id}`, { method: "DELETE" });
          return renderOrders(type);
        }
        const body = {};
        if (btn.dataset.action === "edit") {
          const item = order?.items[0];
          const quantity = prompt("Quantity", item?.quantity || 1);
          if (quantity === null) return;
          body.purpose =
            prompt("Purpose / reason", order?.purpose || "") ??
            order?.purpose ??
            "";
          body.file_reference = order?.file_reference || "";
          body.items = [{ equipment_id: item.equipment_id, quantity }];
        }
        if (btn.dataset.decision) {
          body.decision = btn.dataset.decision;
          body.comment = prompt("Decision reason / comment", "") || "";
        }
        await api(`/api/orders/${btn.dataset.id}/${btn.dataset.action}`, {
          method: "PUT",
          body: JSON.stringify(body),
        });
        renderOrders(type);
      }),
  );
}

function proposalTable(items) {
  return `<div class="table-wrap"><table><thead><tr><th>ID / Submitted</th><th>Equipment</th><th>Operation</th><th>Location</th><th>Quantity / Count</th><th>Status</th><th>Decision</th></tr></thead><tbody>${items.map((p) => `<tr><td><b>#${p.id}</b><br><span class="hint">${esc(localTime(p.created_at))}<br>${esc(p.proposer_name)}</span></td><td><b>${esc(p.equipment_no)}</b><br>${esc(p.equipment_name)}</td><td>${esc(movementLabels[p.source_type] || p.source_type)}<br><span class="hint">${esc(p.reference || p.lot_reference || "-")}</span></td><td>${esc(p.locate_no)} - ${esc(p.location_name)}</td><td>${p.actual_quantity ?? p.quantity ?? "-"} ${esc(p.unit)}</td><td>${statusBadge(p.status)}</td><td class="actions">${hasRole("store_manager") && p.status === "pending_manager" ? `<button data-proposal-action="approve" data-id="${p.id}">Approve &amp; Post</button><button class="danger" data-proposal-action="reject" data-id="${p.id}">Reject</button>` : `<span class="hint">${esc(p.review_comment || "No action")}</span>`}</td></tr>`).join("") || '<tr><td colspan="7">No stock proposals</td></tr>'}</tbody></table></div>`;
}
function bindProposalActions() {
  document.querySelectorAll("[data-proposal-action]").forEach(
    (btn) =>
      (btn.onclick = async () => {
        const comment = prompt("Decision reason / comment", "") || "";
        await api(
          `/api/stock-proposals/${btn.dataset.id}/${btn.dataset.proposalAction}`,
          { method: "PUT", body: JSON.stringify({ comment }) },
        );
        loadApprovalCenter();
      }),
  );
}
function returnedGoodsButtons(g) {
  if (hasRole("store") && g.status === "awaiting_inspection")
    return `<button data-goods-action="inspect" data-disposition="restock" data-id="${g.id}">Recommend Restock</button><button class="danger" data-goods-action="inspect" data-disposition="discontinue" data-id="${g.id}">Recommend Discontinue</button>`;
  if (hasRole("store_manager") && g.status.startsWith("pending_manager_"))
    return `<button data-goods-action="approve" data-id="${g.id}">Approve Decision</button><button class="danger" data-goods-action="reject" data-id="${g.id}">Return for Reinspection</button>`;
  return '<span class="hint">No action required</span>';
}
function returnedGoodsTable(items) {
  return `<div class="table-wrap"><table><thead><tr><th>Item</th><th>Equipment</th><th>Quantity</th><th>Controlled Area</th><th>Status</th><th>Inspection</th><th>Available Actions</th></tr></thead><tbody>${items.map((g) => `<tr><td><b>#${g.id}</b><br><span class="hint">Return #${g.order_id}</span></td><td><b>${esc(g.equipment_no)}</b><br>${esc(g.equipment_name)}</td><td>${g.quantity} ${esc(g.unit)}</td><td>${esc(g.location_name || "Returned Goods")}</td><td>${statusBadge(g.status)}</td><td>${esc(g.inspection_note || g.manager_comment || "-")}</td><td class="actions">${returnedGoodsButtons(g)}</td></tr>`).join("") || '<tr><td colspan="7">No returned goods</td></tr>'}</tbody></table></div>`;
}
function bindReturnedGoodsActions(reload = loadApprovalCenter) {
  document.querySelectorAll("[data-goods-action]").forEach(
    (btn) =>
      (btn.onclick = async () => {
        const comment = prompt("Inspection / decision note", "") || "";
        const body = { comment };
        if (btn.dataset.disposition) body.disposition = btn.dataset.disposition;
        await api(
          `/api/returned-goods/${btn.dataset.id}/${btn.dataset.goodsAction}`,
          { method: "PUT", body: JSON.stringify(body) },
        );
        reload();
      }),
  );
}
async function loadReturnedGoods(filter = "") {
  const data = await api("/api/returned-goods");
  const items =
    filter === "restock"
      ? data.returned_goods.filter((g) =>
          ["pending_manager_restock", "in_stock"].includes(g.status),
        )
      : data.returned_goods;
  content(
    filter === "restock"
      ? "Incoming Equipment - Return Equipment"
      : "Returned Goods",
    `<section class="panel"><p class="hint">Returned items remain in this controlled area until an Officer inspection and final Manager decision are complete.</p>${returnedGoodsTable(items)}</section>`,
  );
  bindReturnedGoodsActions(() => loadReturnedGoods(filter));
}

async function loadApprovalCenter() {
  const [requests, returns, proposals, goods] = await Promise.all([
    api("/api/orders?type=request"),
    api("/api/orders?type=return"),
    api("/api/stock-proposals"),
    api("/api/returned-goods"),
  ]);
  const pendingRequests = requests.orders.filter(
    (o) => o.status === "pending_manager_approval",
  );
  const pendingReturns = returns.orders.filter(
    (o) => o.status === "pending_manager_acceptance",
  );
  const pendingProposals = proposals.proposals.filter(
    (p) => p.status === "pending_manager",
  );
  const pendingGoods = goods.returned_goods.filter((g) =>
    g.status.startsWith("pending_manager_"),
  );
  content(
    "Approval Center",
    `<div class="stats"><div class="stat">Request approvals<b>${pendingRequests.length}</b></div><div class="stat">Return approvals<b>${pendingReturns.length}</b></div><div class="stat">Stock proposals<b>${pendingProposals.length}</b></div><div class="stat">Returned goods<b>${pendingGoods.length}</b></div></div><section class="panel"><h2>Requests waiting for final decision</h2><div id="approvalRequests">${ordersTable(pendingRequests, "request")}</div></section><section class="panel space-top"><h2>Returns waiting for acceptance</h2><div id="approvalReturns">${ordersTable(pendingReturns, "return")}</div></section><section class="panel space-top"><h2>Stock postings</h2>${proposalTable(pendingProposals)}</section><section class="panel space-top"><h2>Returned Goods decisions</h2>${returnedGoodsTable(pendingGoods)}</section>`,
  );
  bindApprovalOrderActions("approvalRequests");
  bindApprovalOrderActions("approvalReturns");
  bindProposalActions();
  bindReturnedGoodsActions();
}
function bindApprovalOrderActions(containerId) {
  document.querySelectorAll(`#${containerId} [data-action]`).forEach(
    (btn) =>
      (btn.onclick = async () => {
        const body = {
          decision: btn.dataset.decision,
          comment: prompt("Decision reason / comment", "") || "",
        };
        await api(`/api/orders/${btn.dataset.id}/${btn.dataset.action}`, {
          method: "PUT",
          body: JSON.stringify(body),
        });
        loadApprovalCenter();
      }),
  );
}
async function loadOperationsQueue() {
  const [requests, returns, proposals] = await Promise.all([
    api("/api/orders?type=request"),
    api("/api/orders?type=return"),
    api("/api/stock-proposals"),
  ]);
  const requestQueue = requests.orders.filter((o) =>
    ["pending", "manager_approved"].includes(o.status),
  );
  const returnQueue = returns.orders.filter((o) =>
    ["pending", "return_delivered"].includes(o.status),
  );
  const myProposals = proposals.proposals.filter(
    (p) => p.proposer_id === state.user.id,
  );
  content(
    "Operations Queue",
    `<section class="panel"><h2>Request preparation and delivery</h2><div id="queueRequests">${ordersTable(requestQueue, "request")}</div></section><section class="panel space-top"><h2>Return receiving</h2><div id="queueReturns">${ordersTable(returnQueue, "return")}</div></section><section class="panel space-top"><h2>My stock proposals</h2>${proposalTable(myProposals)}</section>`,
  );
  bindQueueActions("queueRequests");
  bindQueueActions("queueReturns");
}
function bindQueueActions(containerId) {
  document.querySelectorAll(`#${containerId} [data-action]`).forEach(
    (btn) =>
      (btn.onclick = async () => {
        await api(`/api/orders/${btn.dataset.id}/${btn.dataset.action}`, {
          method: "PUT",
          body: "{}",
        });
        loadOperationsQueue();
      }),
  );
}
function syslogTable(items) {
  return `<div class="table-wrap"><table><thead><tr><th>Local Time</th><th>User</th><th>Action</th><th>Entity</th><th>Details</th></tr></thead><tbody>${items.map((s) => `<tr><td>${esc(localTime(s.created_at))}</td><td>${esc(s.username || "system")}</td><td>${esc(s.action)}</td><td>${esc(s.entity_type)} #${s.entity_id || ""}</td><td>${esc(s.details)}</td></tr>`).join("") || '<tr><td colspan="5">No activity found</td></tr>'}</tbody></table></div>`;
}
async function loadOfficerActivity() {
  const data = await api("/api/syslog");
  const activity = data.syslog.filter((s) =>
    [
      "prepare",
      "deliver",
      "receive_return",
      "inspect",
      "propose",
      "stock_movement",
    ].includes(s.action),
  );
  content(
    "Store Officer Activity",
    `<section class="panel">${syslogTable(activity)}</section>`,
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
  const selectedRoles = user.roles || (user.role ? [user.role] : []);
  const roleOptions = Object.entries(roleLabels)
    .map(
      ([key, label]) =>
        `<label><input type="checkbox" name="roles" value="${key}" ${selectedRoles.includes(key) ? "checked" : ""} ${disabled}> ${label}</label>`,
    )
    .join("");
  return `<form id="userForm" class="form-grid"><input name="active" type="hidden" value="${user.active ?? 1}"><div class="grid-2"><label>Username <input name="username" required value="${esc(user.username)}" ${disabled}></label><label>Full name <input name="full_name" required value="${esc(user.full_name)}" ${disabled}></label></div><div class="grid-2"><label>Password <input name="password" type="password" ${editing ? "" : "required"} ${disabled} placeholder="${editing ? "Leave blank to keep current password" : ""}"></label><fieldset><legend>Roles</legend><div class="role-options">${roleOptions}</div></fieldset></div><div class="actions">${actions}</div></form>`;
}
function usersTable(users) {
  const busy = state.userMode !== "idle";
  return `<table><thead><tr><th>User</th><th>Name</th><th>Role</th><th>Status</th><th>Update</th><th>Active</th><th>Delete</th></tr></thead><tbody>${users.map((user) => `<tr><td>${esc(user.username)}</td><td>${esc(user.full_name)}</td><td>${esc((user.roles || [user.role]).map((role) => roleLabels[role]).join(", "))}</td><td><span class="badge ${user.active ? "ok" : ""}">${user.active ? "Active" : "Inactive"}</span></td><td><button class="secondary" data-update-user="${user.id}" ${busy ? "disabled" : ""}>Update</button></td><td><button class="secondary" data-toggle-user="${user.id}" ${busy ? "disabled" : ""}>${user.active ? "Deactivate" : "Activate"}</button></td><td><button class="danger" data-delete-user="${user.id}" ${busy ? "disabled" : ""}>Delete</button></td></tr>`).join("") || `<tr><td colspan="7">No users found</td></tr>`}</tbody></table>`;
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
  const form = event.target;
  const data = formData(form);
  data.roles = [...form.querySelectorAll("[name=roles]:checked")].map(
    (input) => input.value,
  );
  if (!data.roles.length) {
    alert("Select at least one role.");
    return;
  }
  const editing = state.userMode === "edit";
  const saveButton = form.querySelector("button[type=submit]");
  saveButton.disabled = true;
  try {
    await api(editing ? `/api/users/${state.editingUserId}` : "/api/users", {
      method: editing ? "PUT" : "POST",
      body: JSON.stringify(data),
    });
    resetUserMode();
    await loadUsers();
  } catch (error) {
    alert(error.message);
    saveButton.disabled = false;
  }
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
