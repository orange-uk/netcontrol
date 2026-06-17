// netcontrol/src/state.js
// Persists groups, devices, and schedules to disk so they survive restarts

import fs from 'fs';
import path from 'path';
import { config } from './config.js';

const dataPath = path.resolve(config.dataFile);

const defaultState = {
  groups: [],
};

function load() {
  try {
    if (fs.existsSync(dataPath)) {
      return JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    }
  } catch (e) {
    console.error('[state] Failed to load state, starting fresh:', e.message);
  }
  return structuredClone(defaultState);
}

function save(state) {
  try {
    fs.mkdirSync(path.dirname(dataPath), { recursive: true });
    fs.writeFileSync(dataPath, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('[state] Failed to save state:', e.message);
  }
  notifyChange();
}

let state = load();

// Change subscribers — notified after every persisted mutation so dependents
// (e.g. the DNS resolver's blocklist) can stay in sync with saved state.
const changeListeners = [];
export function onChange(cb) {
  changeListeners.push(cb);
}
function notifyChange() {
  for (const cb of changeListeners) {
    try { cb(state); } catch (e) { console.error('[state] change listener error:', e.message); }
  }
}

export function getState() {
  return state;
}

export function getGroups() {
  return state.groups;
}

export function getGroup(id) {
  return state.groups.find(g => g.id === id);
}

export function upsertGroup(group) {
  const idx = state.groups.findIndex(g => g.id === group.id);
  if (idx >= 0) {
    state.groups[idx] = group;
  } else {
    state.groups.push(group);
  }
  save(state);
}

export function deleteGroup(id) {
  state.groups = state.groups.filter(g => g.id !== id);
  save(state);
}

export function setGroupBlocked(id, blocked) {
  const group = getGroup(id);
  if (!group) return null;
  group.blocked = blocked;
  // If manually toggled, clear any temporary override
  group.manualOverride = true;
  save(state);
  return group;
}

export function clearManualOverride(id) {
  const group = getGroup(id);
  if (!group) return;
  group.manualOverride = false;
  save(state);
}
