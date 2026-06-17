// netcontrol/src/scheduler/index.js
// Runs every minute, checks all group schedules, and enforces block/unblock

import cron from 'node-cron';
import { getGroups, setGroupBlocked, getGroup } from '../state.js';
import { setGroupAccess } from '../resolver/control.js';

const DAY_MAP = {
  Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0,
};

function parseTime(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function currentMinutes() {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

function currentDay() {
  return new Date().getDay(); // 0=Sun, 1=Mon...
}

function isInBlockWindow(schedule) {
  const today = currentDay();
  const now = currentMinutes();

  const activeDays = schedule.days.map(d => DAY_MAP[d]);
  if (!activeDays.includes(today)) return false;

  const off = parseTime(schedule.offTime);
  const on = parseTime(schedule.onTime);

  if (off < on) {
    // Same-day window e.g. 14:00 off → 17:00 on
    return now >= off && now < on;
  } else {
    // Overnight window e.g. 22:00 off → 07:00 on
    // Also need to check if we're in the "on" day's early hours
    const yesterday = (today + 6) % 7;
    const yesterdayActive = activeDays.includes(yesterday);

    if (now >= off) return true;                        // after off time today
    if (yesterdayActive && now < on) return true;       // before on time, carry-over from yesterday
    return false;
  }
}

function shouldBeBlocked(group) {
  if (!group.schedules || group.schedules.length === 0) return null; // no opinion
  return group.schedules.some(s => isInBlockWindow(s));
}

async function tick() {
  const groups = getGroups();

  for (const group of groups) {
    // If manually overridden, skip schedule enforcement
    if (group.manualOverride) continue;

    const scheduleSaysBlocked = shouldBeBlocked(group);
    if (scheduleSaysBlocked === null) continue; // no schedules

    if (scheduleSaysBlocked !== group.blocked) {
      console.log(`[scheduler] ${group.name}: ${scheduleSaysBlocked ? 'blocking' : 'unblocking'} (schedule)`);
      setGroupBlocked(group.id, scheduleSaysBlocked);
      await setGroupAccess(getGroup(group.id), scheduleSaysBlocked);
    }
  }
}

export function startScheduler() {
  console.log('[scheduler] Starting — checking every minute');
  cron.schedule('* * * * *', tick);
  // Also run immediately on startup
  tick().catch(console.error);
}
