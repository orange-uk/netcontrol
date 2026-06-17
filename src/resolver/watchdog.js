// netcontrol/src/resolver/watchdog.js
//
// Periodically probes the local DNS resolver with an internal health query
// (HEALTH_NAME, answered locally so the check doesn't depend on the upstream/
// internet). If the resolver stops responding it logs the failure and restarts
// the listener. The blocklist is module state, so blocking survives the restart.

import dgram from 'dgram';
import dnsPacket from 'dns-packet';
import { config } from '../config.js';
import { HEALTH_NAME, restartResolver } from './index.js';

const PORT = config.resolver.port;
const INTERVAL = config.resolver.watchdogIntervalMs ?? 30000;
const PROBE_TIMEOUT = config.resolver.watchdogProbeTimeoutMs ?? 2000;

let probeSeq = 0;
let busy = false;
let timer = null;

// Send one health query to the resolver; resolve(true) if it answers in time.
function probeOnce() {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const id = (probeSeq++ % 65535) + 1;
    const query = dnsPacket.encode({
      type: 'query', id,
      flags: dnsPacket.RECURSION_DESIRED,
      questions: [{ type: 'A', name: HEALTH_NAME }],
    });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      try { sock.close(); } catch {}
      resolve(ok);
    };
    const t = setTimeout(() => finish(false), PROBE_TIMEOUT);
    sock.on('message', (msg) => {
      try { const r = dnsPacket.decode(msg); finish(r.id === id && r.type === 'response'); }
      catch { finish(false); }
    });
    sock.on('error', () => finish(false));
    sock.send(query, PORT, '127.0.0.1', (err) => { if (err) finish(false); });
  });
}

async function tick() {
  if (busy) return; // never overlap with an in-progress restart
  busy = true;
  try {
    if (await probeOnce()) return;          // healthy — stay quiet
    if (await probeOnce()) return;          // one retry absorbs a dropped UDP packet
    console.error(`[watchdog] DNS resolver not responding on 127.0.0.1:${PORT} — restarting`);
    await restartResolver();
    if (await probeOnce()) console.log('[watchdog] resolver restarted and responding again');
    else console.error('[watchdog] resolver STILL not responding after restart');
  } catch (e) {
    console.error('[watchdog] error:', e.message);
  } finally {
    busy = false;
  }
}

export function startWatchdog() {
  if (timer) return;
  console.log(`[watchdog] monitoring DNS resolver every ${Math.round(INTERVAL / 1000)}s`);
  timer = setInterval(tick, INTERVAL);
  if (timer.unref) timer.unref(); // don't keep the process alive just for this timer
}

export function stopWatchdog() {
  if (timer) { clearInterval(timer); timer = null; }
}
