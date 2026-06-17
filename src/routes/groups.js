// netcontrol/src/routes/groups.js

import { Router } from 'express';
import { requireAuth } from './auth.js';
import {
  getGroups, getGroup, upsertGroup, deleteGroup,
  setGroupBlocked, clearManualOverride,
} from '../state.js';
import { setGroupAccess } from '../resolver/control.js';

const router = Router();

// GET /api/groups — list all groups
router.get('/', (req, res) => {
  res.json(getGroups());
});

// GET /api/groups/:id — single group
router.get('/:id', (req, res) => {
  const group = getGroup(req.params.id);
  if (!group) return res.status(404).json({ error: 'Not found' });
  res.json(group);
});

// POST /api/groups — create group
router.post('/', requireAuth, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const group = {
    id: Date.now().toString(),
    name,
    devices: [],
    schedules: [],
    blocked: false,
    manualOverride: false,
  };
  upsertGroup(group);
  res.status(201).json(group);
});

// PUT /api/groups/:id — update group name
router.put('/:id', requireAuth, (req, res) => {
  const group = getGroup(req.params.id);
  if (!group) return res.status(404).json({ error: 'Not found' });
  if (req.body.name) group.name = req.body.name;
  upsertGroup(group);
  res.json(group);
});

// DELETE /api/groups/:id
router.delete('/:id', requireAuth, async (req, res) => {
  const group = getGroup(req.params.id);
  if (!group) return res.status(404).json({ error: 'Not found' });
  // Unblock before deleting
  if (group.blocked) await setGroupAccess(group, false);
  deleteGroup(req.params.id);
  res.json({ ok: true });
});

// POST /api/groups/:id/toggle — block or unblock
router.post('/:id/toggle', requireAuth, async (req, res) => {
  const { blocked } = req.body;
  if (typeof blocked !== 'boolean') return res.status(400).json({ error: 'blocked (boolean) required' });
  const group = setGroupBlocked(req.params.id, blocked);
  if (!group) return res.status(404).json({ error: 'Not found' });
  const results = await setGroupAccess(group, blocked);
  res.json({ ok: true, group, pihole: results });
});

// POST /api/groups/:id/resume — clear manual override, let schedule take over
router.post('/:id/resume', requireAuth, (req, res) => {
  clearManualOverride(req.params.id);
  res.json({ ok: true });
});

// POST /api/groups/:id/devices — add device
router.post('/:id/devices', requireAuth, (req, res) => {
  const group = getGroup(req.params.id);
  if (!group) return res.status(404).json({ error: 'Not found' });
  const { name, mac, ip } = req.body;
  if (!name || !mac) return res.status(400).json({ error: 'name and mac required' });
  const device = { id: Date.now().toString(), name, mac: mac.toUpperCase(), ip: ip || null };
  group.devices.push(device);
  upsertGroup(group);
  res.status(201).json(device);
});

// DELETE /api/groups/:id/devices/:deviceId
router.delete('/:id/devices/:deviceId', requireAuth, async (req, res) => {
  const group = getGroup(req.params.id);
  if (!group) return res.status(404).json({ error: 'Not found' });
  const device = group.devices.find(d => d.id === req.params.deviceId);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  // Unblock device before removing
  if (group.blocked && device.ip) {
    await setGroupAccess({ devices: [device] }, false);
  }
  group.devices = group.devices.filter(d => d.id !== req.params.deviceId);
  upsertGroup(group);
  res.json({ ok: true });
});

// POST /api/groups/:id/schedules — add schedule
router.post('/:id/schedules', requireAuth, (req, res) => {
  const group = getGroup(req.params.id);
  if (!group) return res.status(404).json({ error: 'Not found' });
  const { days, offTime, onTime } = req.body;
  if (!days?.length || !offTime || !onTime) {
    return res.status(400).json({ error: 'days, offTime, onTime required' });
  }
  const schedule = { id: Date.now().toString(), days, offTime, onTime };
  group.schedules.push(schedule);
  // Adding a schedule clears manual override so scheduler takes over
  group.manualOverride = false;
  upsertGroup(group);
  res.status(201).json(schedule);
});

// DELETE /api/groups/:id/schedules/:scheduleId
router.delete('/:id/schedules/:scheduleId', requireAuth, (req, res) => {
  const group = getGroup(req.params.id);
  if (!group) return res.status(404).json({ error: 'Not found' });
  group.schedules = group.schedules.filter(s => s.id !== req.params.scheduleId);
  upsertGroup(group);
  res.json({ ok: true });
});

export default router;
