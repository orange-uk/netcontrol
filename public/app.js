// netcontrol/public/app.js
// Vanilla JS frontend — no build step required

const DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

// ─── State ───────────────────────────────────────────────────────────────────
// Token storage — uses localStorage for remember-me, sessionStorage as fallback
function getStoredToken() {
  const stored = localStorage.getItem('nc_token');
  if (stored) {
    try {
      const { token, expiry } = JSON.parse(stored);
      if (Date.now() < expiry) return token;
      localStorage.removeItem('nc_token');
    } catch {}
  }
  return sessionStorage.getItem('nc_token') || null;
}

function storeToken(token, rememberMe) {
  if (rememberMe) {
    localStorage.setItem('nc_token', JSON.stringify({
      token,
      expiry: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
    }));
  } else {
    sessionStorage.setItem('nc_token', token);
  }
}

function clearStoredToken() {
  localStorage.removeItem('nc_token');
  sessionStorage.removeItem('nc_token');
}

let authToken = getStoredToken();
let groups = [];
let currentGroupId = null;
let selectedDays = [];

// ─── API ─────────────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (authToken) opts.headers['x-auth-token'] = authToken;
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`/api${path}`, opts);
  if (res.status === 401) {
    authToken = null;
    clearStoredToken();
    showScreen('pin-screen');
    throw new Error('Session expired — please log in again');
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const GET = (path) => api('GET', path);
const POST = (path, body) => api('POST', path, body);
const PUT = (path, body) => api('PUT', path, body);
const DEL = (path) => api('DELETE', path);

// ─── Toast ────────────────────────────────────────────────────────────────────
let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}

// ─── Screens ─────────────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  window.scrollTo(0, 0);
}

// ─── PIN ─────────────────────────────────────────────────────────────────────
let pinEntry = '';

window.pinPress = function(d) {
  if (pinEntry.length >= 4) return;
  pinEntry += d;
  updateDots();
  if (pinEntry.length === 4) setTimeout(checkPin, 120);
};

window.pinBackspace = function() {
  pinEntry = pinEntry.slice(0, -1);
  document.getElementById('pin-error').textContent = '';
  updateDots();
};

function updateDots() {
  for (let i = 0; i < 4; i++) {
    document.getElementById('pd' + i).classList.toggle('filled', i < pinEntry.length);
  }
}

async function checkPin() {
  try {
    const rememberMe = document.getElementById('remember-me')?.checked ?? false;
    const res = await POST('/auth/login', { pin: pinEntry });
    authToken = res.token;
    storeToken(authToken, rememberMe);
    pinEntry = '';
    updateDots();
    await loadGroups();
    showScreen('main-screen');
  } catch {
    document.getElementById('pin-error').textContent = 'Incorrect PIN — try again';
    pinEntry = '';
    updateDots();
  }
}

async function lockApp() {
  try { await POST('/auth/logout'); } catch {}
  authToken = null;
  clearStoredToken();
  pinEntry = '';
  updateDots();
  document.getElementById('pin-error').textContent = '';
  showScreen('pin-screen');
}

// ─── Groups list ─────────────────────────────────────────────────────────────
async function loadGroups() {
  groups = await GET('/groups');
  renderGroups();
  checkResolverStatus();
}

async function checkResolverStatus() {
  try {
    const { resolver } = await GET('/status');
    const dot = document.getElementById('pihole-dot');
    const label = document.getElementById('pihole-label');
    if (dot && label) {
      dot.className = 'status-dot ' + (resolver?.ok ? 'ok' : 'err');
      label.textContent = resolver?.ok
        ? `DNS active · port ${resolver.listening}`
        : 'DNS resolver offline';
    }
  } catch {}
}

function renderGroups() {
  const el = document.getElementById('groups-list');
  const blocked = groups.filter(g => g.blocked).length;
  document.getElementById('status-line').textContent =
    `${groups.length} group${groups.length !== 1 ? 's' : ''} · ${blocked === 0 ? 'all online' : blocked + ' blocked'}`;

  if (groups.length === 0) {
    el.innerHTML = '<div class="empty-state">No groups yet — add one below</div>';
    return;
  }

  el.innerHTML = groups.map(g => {
    const sched = g.schedules?.[0];
    return `<div class="card">
      <div class="group-header">
        <div style="cursor:pointer;flex:1" onclick="openGroup('${g.id}')">
          <div class="group-name">${esc(g.name)}</div>
          <div class="group-meta">${g.devices.length} device${g.devices.length !== 1 ? 's' : ''}</div>
        </div>
        <label class="toggle" aria-label="Toggle ${esc(g.name)}">
          <input type="checkbox" ${g.blocked ? '' : 'checked'}
            onchange="toggleGroup('${g.id}', this.checked)">
          <span class="toggle-track"></span>
          <span class="toggle-thumb"></span>
        </label>
      </div>
      ${g.blocked ? '<span class="badge badge-blocked">Blocked</span>' : ''}
      ${sched && !g.blocked
        ? `<span class="badge badge-schedule">Off ${sched.offTime} · On ${sched.onTime} · ${sched.days.join(', ')}</span>`
        : ''}
      <div class="devices-list">
        ${g.devices.map(d =>
          `<div class="device-row"><div class="device-dot ${!g.blocked ? 'online' : ''}"></div>${esc(d.name)}</div>`
        ).join('')}
      </div>
    </div>`;
  }).join('');
}

window.openGroup = openGroup;
window.showScreen = showScreen;
window.renderGroups = renderGroups;
window.renderGroupDetail = renderGroupDetail;
window.toggleGroup = toggleGroup;
window.lockApp = lockApp;
window.resumeSchedule = resumeSchedule;

async function toggleGroup(id, isOn) {
  try {
    await POST(`/groups/${id}/toggle`, { blocked: !isOn });
    const g = groups.find(x => x.id === id);
    if (g) g.blocked = !isOn;
    renderGroups();
    toast(isOn ? 'Internet allowed' : 'Internet blocked');
  } catch (e) {
    toast('Error: ' + e.message);
    await loadGroups(); // revert UI
  }
}

// ─── Group detail ─────────────────────────────────────────────────────────────
async function openGroup(id) {
  currentGroupId = id;
  await refreshCurrentGroup();
  renderGroupDetail();
  showScreen('group-detail-screen');
}

async function refreshCurrentGroup() {
  const g = await GET(`/groups/${currentGroupId}`);
  const idx = groups.findIndex(x => x.id === currentGroupId);
  if (idx >= 0) groups[idx] = g; else groups.push(g);
}

function getCurrentGroup() {
  return groups.find(x => x.id === currentGroupId);
}

function renderGroupDetail() {
  const g = getCurrentGroup();
  if (!g) return;
  const el = document.getElementById('group-detail-screen');

  el.innerHTML = `
    <div class="detail-header">
      <button class="back-btn" onclick="showScreen('main-screen');renderGroups()" aria-label="Back">&#8592;</button>
      <h1>${esc(g.name)}</h1>
      <div class="actions">
        <button class="icon-btn" onclick="showEditGroup('${g.id}')" aria-label="Rename">&#9998;</button>
        <button class="icon-btn danger" onclick="confirmDeleteGroup('${g.id}')" aria-label="Delete">&#128465;</button>
      </div>
    </div>

    <div class="card" style="margin-bottom:1rem">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div>
          <div style="font-size:14px;font-weight:500">Internet access</div>
          <div style="font-size:12px;color:var(--text2);margin-top:2px">
            ${g.blocked ? 'Currently blocked' : g.manualOverride ? 'Manually allowed' : 'Allowed'}
          </div>
        </div>
        <label class="toggle">
          <input type="checkbox" ${g.blocked ? '' : 'checked'}
            onchange="toggleGroup('${g.id}', this.checked);setTimeout(()=>renderGroupDetail(),300)">
          <span class="toggle-track"></span>
          <span class="toggle-thumb"></span>
        </label>
      </div>
      ${g.manualOverride && g.schedules.length > 0
        ? `<button class="add-btn" style="margin-top:0.75rem;border-style:solid" onclick="resumeSchedule('${g.id}')">
            Resume schedule
          </button>`
        : ''}
    </div>

    <p class="section-label">Devices</p>
    <div class="list-card" style="margin-bottom:0.5rem">
      ${g.devices.length === 0
        ? '<div class="empty-state" style="padding:1rem">No devices — add one below</div>'
        : g.devices.map(d => `
          <div class="list-row">
            <div>
              <div class="list-row-main">${esc(d.name)}</div>
              <div class="list-row-sub">${esc(d.mac)}${d.ip ? ' · ' + esc(d.ip) : ''}</div>
            </div>
            <button class="icon-btn danger" onclick="removeDevice('${g.id}','${d.id}')" aria-label="Remove">&#215;</button>
          </div>`).join('')}
    </div>
    <button class="add-btn" style="margin-bottom:1.5rem" onclick="showAddDevice('${g.id}')">+ Add device</button>

    <p class="section-label">Schedules</p>
    ${g.schedules.length === 0 ? '<div class="empty-state">No schedules yet</div>' : ''}
    ${g.schedules.length > 0
      ? `<div class="list-card" style="margin-bottom:0.5rem">
          ${g.schedules.map(s => `
            <div class="list-row">
              <div>
                <div class="list-row-main">Off ${esc(s.offTime)} · On ${esc(s.onTime)}</div>
                <div style="font-size:12px;color:var(--text2);margin-top:2px">${s.days.join(', ')}</div>
              </div>
              <button class="icon-btn danger" onclick="deleteSchedule('${g.id}','${s.id}')" aria-label="Delete">&#128465;</button>
            </div>`).join('')}
        </div>`
      : ''}
    <button class="add-btn" onclick="showAddSchedule('${g.id}')">+ Add schedule</button>
  `;
}

async function resumeSchedule(id) {
  await POST(`/groups/${id}/resume`);
  await refreshCurrentGroup();
  renderGroupDetail();
  toast('Schedule resumed');
}

// ─── Modals ───────────────────────────────────────────────────────────────────
function openModal(html) {
  document.getElementById('modal-content').innerHTML = html;
  document.getElementById('modal-overlay').classList.add('open');
}
function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
}
window.closeModal = closeModal;

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-overlay')) closeModal();
  });
});

function showAddGroup() {
  openModal(`
    <div class="modal-handle"></div>
    <h2>New group</h2>
    <div class="field-label">Group name</div>
    <input type="text" id="inp-group-name" placeholder="e.g. Living room" autofocus>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" onclick="addGroup()">Add group</button>
    </div>`);
}
window.showAddGroup = showAddGroup;

async function addGroup() {
  const name = document.getElementById('inp-group-name').value.trim();
  if (!name) return;
  const g = await POST('/groups', { name });
  groups.push(g);
  closeModal();
  renderGroups();
  toast('Group added');
}
window.addGroup = addGroup;

function showEditGroup(id) {
  const g = groups.find(x => x.id === id);
  openModal(`
    <div class="modal-handle"></div>
    <h2>Rename group</h2>
    <div class="field-label">Group name</div>
    <input type="text" id="inp-edit-name" value="${esc(g.name)}">
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" onclick="saveGroupName('${id}')">Save</button>
    </div>`);
}
window.showEditGroup = showEditGroup;

async function saveGroupName(id) {
  const name = document.getElementById('inp-edit-name').value.trim();
  if (!name) return;
  await PUT(`/groups/${id}`, { name });
  const g = groups.find(x => x.id === id);
  if (g) g.name = name;
  closeModal();
  renderGroupDetail();
  toast('Renamed');
}
window.saveGroupName = saveGroupName;

function confirmDeleteGroup(id) {
  const g = groups.find(x => x.id === id);
  openModal(`
    <div class="modal-handle"></div>
    <h2>Delete "${esc(g.name)}"?</h2>
    <p style="font-size:14px;color:var(--text2);margin-top:0.5rem">All devices and schedules in this group will be removed. Internet access will be restored.</p>
    <div class="modal-actions" style="margin-top:1.5rem">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn-danger" onclick="doDeleteGroup('${id}')">Delete</button>
    </div>`);
}
window.confirmDeleteGroup = confirmDeleteGroup;

async function doDeleteGroup(id) {
  await DEL(`/groups/${id}`);
  groups = groups.filter(x => x.id !== id);
  closeModal();
  showScreen('main-screen');
  renderGroups();
  toast('Group deleted');
}
window.doDeleteGroup = doDeleteGroup;

function showAddDevice(groupId) {
  openModal(`
    <div class="modal-handle"></div>
    <h2>Add device</h2>
    <div class="field-label">Device name</div>
    <input type="text" id="inp-dev-name" placeholder="e.g. Samsung TV" autofocus>
    <div class="field-label">MAC address</div>
    <input type="text" id="inp-dev-mac" placeholder="AA:BB:CC:DD:EE:FF" style="font-family:var(--mono);font-size:13px">
    <div class="field-label">IP address <span style="color:var(--text3)">(optional but needed for blocking)</span></div>
    <input type="text" id="inp-dev-ip" placeholder="192.168.1.x">
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" onclick="addDevice('${groupId}')">Add</button>
    </div>`);
}
window.showAddDevice = showAddDevice;

async function addDevice(groupId) {
  const name = document.getElementById('inp-dev-name').value.trim();
  const mac = document.getElementById('inp-dev-mac').value.trim();
  const ip = document.getElementById('inp-dev-ip').value.trim();
  if (!name) { toast('Enter a device name'); return; }
  if (!mac) { toast('Enter a MAC address'); return; }
  try {
    await POST(`/groups/${groupId}/devices`, { name, mac, ip: ip || null });
    closeModal();
    await refreshCurrentGroup();
    renderGroupDetail();
    toast('Device added');
  } catch (e) {
    toast('Error: ' + e.message);
  }
}
window.addDevice = addDevice;

async function removeDevice(groupId, deviceId) {
  await DEL(`/groups/${groupId}/devices/${deviceId}`);
  await refreshCurrentGroup();
  renderGroupDetail();
  toast('Device removed');
}
window.removeDevice = removeDevice;

function showAddSchedule(groupId) {
  selectedDays = ['Mon','Tue','Wed','Thu','Fri'];
  openModal(`
    <div class="modal-handle"></div>
    <h2>Add schedule</h2>
    <div class="field-label">Days</div>
    <div class="day-pills" id="day-pills">
      ${DAYS.map(d => `<button class="day-pill ${selectedDays.includes(d) ? 'selected' : ''}"
        onclick="toggleDay('${d}')" type="button">${d}</button>`).join('')}
    </div>
    <div class="time-row">
      <div>
        <div class="field-label">Block at</div>
        <input type="time" id="inp-off-time" value="21:30">
      </div>
      <div>
        <div class="field-label">Allow at</div>
        <input type="time" id="inp-on-time" value="07:00">
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" onclick="addSchedule('${groupId}')">Save</button>
    </div>`);
}
window.showAddSchedule = showAddSchedule;

window.toggleDay = function(d) {
  if (selectedDays.includes(d)) selectedDays = selectedDays.filter(x => x !== d);
  else selectedDays.push(d);
  document.querySelectorAll('.day-pill').forEach(btn => {
    btn.classList.toggle('selected', selectedDays.includes(btn.textContent.trim()));
  });
};

async function addSchedule(groupId) {
  if (!selectedDays.length) { toast('Select at least one day'); return; }
  const offTime = document.getElementById('inp-off-time').value;
  const onTime = document.getElementById('inp-on-time').value;
  const orderedDays = DAYS.filter(d => selectedDays.includes(d));
  await POST(`/groups/${groupId}/schedules`, { days: orderedDays, offTime, onTime });
  closeModal();
  await refreshCurrentGroup();
  renderGroupDetail();
  toast('Schedule saved');
}
window.addSchedule = addSchedule;

async function deleteSchedule(groupId, schedId) {
  await DEL(`/groups/${groupId}/schedules/${schedId}`);
  await refreshCurrentGroup();
  renderGroupDetail();
  toast('Schedule removed');
}
window.deleteSchedule = deleteSchedule;

// ─── Utilities ────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  // If we have a stored token, try to resume session
  if (authToken) {
    try {
      await loadGroups();
      showScreen('main-screen');
      return;
    } catch {
      authToken = null;
      clearStoredToken();
    }
  }
  showScreen('pin-screen');
}

// Build static HTML structure
document.getElementById('root').innerHTML = `
  <div id="toast" class="toast"></div>
  <div id="modal-overlay" class="modal-overlay">
    <div class="modal" id="modal-content"></div>
  </div>

  <div id="pin-screen" class="screen">
    <div class="pin-screen">
      <div style="text-align:center">
        <div style="font-size:32px;margin-bottom:0.75rem">&#128274;</div>
        <p style="font-size:18px;font-weight:500">Network control</p>
        <p style="font-size:13px;color:var(--text2);margin-top:4px">Enter your PIN to continue</p>
      </div>
      <div class="pin-dots" id="pin-dots">
        <div class="pin-dot" id="pd0"></div>
        <div class="pin-dot" id="pd1"></div>
        <div class="pin-dot" id="pd2"></div>
        <div class="pin-dot" id="pd3"></div>
      </div>
      <div class="pin-error" id="pin-error"></div>
      <div class="pin-grid">
        ${[1,2,3,4,5,6,7,8,9].map(n => `<button class="pin-btn" onclick="pinPress('${n}')">${n}</button>`).join('')}
        <button class="pin-btn" style="visibility:hidden"></button>
        <button class="pin-btn" onclick="pinPress('0')">0</button>
        <button class="pin-btn" onclick="pinBackspace()" aria-label="delete">&#9003;</button>
      </div>
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text2);cursor:pointer;margin-top:-0.5rem">
        <input type="checkbox" id="remember-me" style="width:16px;height:16px;accent-color:var(--green)">
        Remember me for 24 hours
      </label>
    </div>
  </div>

  <div id="main-screen" class="screen">
    <div class="topbar">
      <div>
        <h1>Network control</h1>
        <div class="pihole-status">
          <div class="status-dot" id="pihole-dot"></div>
          <span id="pihole-label">Checking DNS...</span>
        </div>
        <p style="font-size:12px;color:var(--text2);margin-top:2px" id="status-line"></p>
      </div>
      <div class="topbar-actions">
        <button class="icon-btn" onclick="showAddGroup()" aria-label="Add group" style="font-size:22px">+</button>
        <button class="icon-btn" onclick="lockApp()" aria-label="Lock" style="font-size:16px">&#128274;</button>
      </div>
    </div>
    <div class="section-label">Device groups</div>
    <div id="groups-list"></div>
    <button class="add-btn" onclick="showAddGroup()">+ Add group</button>
  </div>

  <div id="group-detail-screen" class="screen"></div>
`;

boot();
