// netcontrol/src/resolver/control.js
//
// Bridges netcontrol's group/device state to the native DNS resolver.
// Replaces the old Pi-hole API integration: instead of pushing per-client rules
// into Pi-hole, we compute the set of blocked client IPs from the saved state and
// hand it to the in-process resolver.
//
// Keeps the same exported interface the rest of the app already uses
// (`setGroupAccess`, `getStatus`) so routes/scheduler/server need no behaviour change.

import { getGroups, onChange } from '../state.js';
import { setBlockedIps, getResolverStatus } from './index.js';

// A device is blocked when its group is blocked. Union all such device IPs.
function computeBlockedIps() {
  const ips = new Set();
  for (const group of getGroups()) {
    if (!group.blocked) continue;
    for (const device of group.devices ?? []) {
      if (device.ip) ips.add(device.ip);
    }
  }
  return ips;
}

// Recompute the resolver's blocklist from the current persisted state.
// This is the single source of truth — idempotent and drift-free.
export function rebuildBlocklist() {
  setBlockedIps(computeBlockedIps());
}

// Called by the routes and scheduler after they mutate group state.
// We recompute from state (rather than diffing) and return a per-device result
// array so the API response/UI keeps the same shape it had with Pi-hole.
export async function setGroupAccess(group, blocked) {
  rebuildBlocklist();
  return (group?.devices ?? []).map((d) =>
    d.ip
      ? { device: d.name, ok: true }
      : { device: d.name, ok: false, error: 'No IP assigned' }
  );
}

// Health check surfaced at GET /api/status.
export async function getStatus() {
  const s = getResolverStatus();
  return s.ok
    ? { ok: true, mode: 'native-resolver', listening: s.listening, upstreams: s.upstreams, blocked: s.blockedCount }
    : { ok: false, error: 'resolver not listening' };
}

// Any state change (toggle, schedule, add/remove device, delete group) persists
// via state.save(), which fires this — so the resolver is always in sync.
onChange(rebuildBlocklist);
