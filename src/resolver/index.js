// netcontrol/src/resolver/index.js
//
// Native DNS resolver. Runs in the netcontrol process directly on macOS, so it
// sees the REAL source IP of every client query (no Docker/VM NAT in between).
//
// Per-client blocking: if a query's source IP is in the blocked set, we answer
// 0.0.0.0 (A) / :: (AAAA) — i.e. no working internet for that device. Every
// other query is forwarded to the upstream resolvers and relayed back verbatim.
//
// Listens on both UDP and TCP (DNS uses TCP for large/truncated responses).

import dgram from 'dgram';
import net from 'net';
import dnsPacket from 'dns-packet';
import { config } from '../config.js';

const PORT = config.resolver.port;
const UPSTREAMS = config.resolver.upstreams;
const BLOCK_TTL = config.resolver.blockTTL ?? 60;
const QUERY_TIMEOUT = config.resolver.queryTimeoutMs ?? 5000;

// Internal health-check name. The resolver answers this itself (no upstream),
// so the watchdog can verify the listener is alive independently of internet.
export const HEALTH_NAME = 'health.netcontrol.local';

function isLoopback(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

let blockedIps = new Set();
let udpServer = null;
let tcpServer = null;
let upstreamIdx = 0;

// ─── Blocklist ───────────────────────────────────────────────────────────────

export function setBlockedIps(ips) {
  blockedIps = new Set(ips);
  const list = [...blockedIps];
  console.log(`[resolver] blocklist: ${list.length} IP(s) blocked${list.length ? ' — ' + list.join(', ') : ''}`);
}

export function getBlockedIps() {
  return [...blockedIps];
}

function isBlocked(ip) {
  // Normalise IPv4-mapped IPv6 (e.g. ::ffff:192.168.1.126) to plain IPv4.
  return blockedIps.has(ip) || blockedIps.has(ip?.replace(/^::ffff:/i, ''));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function nextUpstream() {
  const u = UPSTREAMS[upstreamIdx % UPSTREAMS.length];
  upstreamIdx++;
  return u;
}

// Build a "blocked" response for a query: 0.0.0.0 for A, :: for AAAA,
// NODATA (no answers, NOERROR) for anything else.
function buildBlockedResponse(msg) {
  const query = dnsPacket.decode(msg);
  const answers = [];
  for (const q of query.questions ?? []) {
    if (q.type === 'A') {
      answers.push({ name: q.name, type: 'A', class: 'IN', ttl: BLOCK_TTL, data: '0.0.0.0' });
    } else if (q.type === 'AAAA') {
      answers.push({ name: q.name, type: 'AAAA', class: 'IN', ttl: BLOCK_TTL, data: '::' });
    }
    // other qtypes: leave as NODATA so the device gets no usable record
  }
  return dnsPacket.encode({
    id: query.id,
    type: 'response',
    flags: dnsPacket.RECURSION_DESIRED | dnsPacket.RECURSION_AVAILABLE,
    questions: query.questions,
    answers,
  });
}

// Answer for the internal watchdog probe (HEALTH_NAME) — fixed, no upstream.
function buildHealthResponse(query) {
  return dnsPacket.encode({
    id: query.id,
    type: 'response',
    flags: dnsPacket.RECURSION_DESIRED | dnsPacket.RECURSION_AVAILABLE,
    questions: query.questions,
    answers: (query.questions ?? [])
      .filter((q) => q.type === 'A')
      .map((q) => ({ name: q.name, type: 'A', class: 'IN', ttl: 0, data: '127.0.0.1' })),
  });
}

// True if this query (only ever sent from loopback by the watchdog) is a probe.
function tryHandleHealth(msg, replyFn) {
  let query;
  try { query = dnsPacket.decode(msg); } catch { return false; }
  if (query.questions?.[0]?.name?.toLowerCase() !== HEALTH_NAME) return false;
  try { replyFn(buildHealthResponse(query)); } catch {}
  return true;
}

// ─── UDP ─────────────────────────────────────────────────────────────────────

function startUdp() {
  udpServer = dgram.createSocket('udp4');

  udpServer.on('message', (msg, rinfo) => {
    // Watchdog probe (loopback only) — answered locally, no upstream needed.
    if (isLoopback(rinfo.address) &&
        tryHandleHealth(msg, (resp) => udpServer.send(resp, rinfo.port, rinfo.address))) {
      return;
    }
    if (isBlocked(rinfo.address)) {
      try {
        udpServer.send(buildBlockedResponse(msg), rinfo.port, rinfo.address);
      } catch {
        /* malformed query — drop */
      }
      return;
    }
    forwardUdp(msg, rinfo);
  });

  udpServer.on('error', (e) => console.error('[resolver] UDP error:', e.message));
  udpServer.bind(PORT, '0.0.0.0', () =>
    console.log(`[resolver] listening on UDP 0.0.0.0:${PORT}`));
}

function forwardUdp(msg, rinfo) {
  const upstream = nextUpstream();
  const sock = dgram.createSocket('udp4');
  let done = false;
  const cleanup = () => { if (!done) { done = true; try { sock.close(); } catch {} } };
  const timer = setTimeout(cleanup, QUERY_TIMEOUT);

  sock.on('message', (resp) => {
    clearTimeout(timer);
    try { udpServer.send(resp, rinfo.port, rinfo.address); } catch {}
    cleanup();
  });
  sock.on('error', () => { clearTimeout(timer); cleanup(); });
  sock.send(msg, 53, upstream, (err) => { if (err) { clearTimeout(timer); cleanup(); } });
}

// ─── TCP (2-byte length-prefixed messages) ───────────────────────────────────

function startTcp() {
  tcpServer = net.createServer((socket) => {
    const clientIp = socket.remoteAddress?.replace(/^::ffff:/i, '');
    socket.setTimeout(QUERY_TIMEOUT + 2000);
    let buf = Buffer.alloc(0);

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const len = buf.readUInt16BE(0);
        if (buf.length < 2 + len) break;
        const msg = buf.subarray(2, 2 + len);
        buf = buf.subarray(2 + len);
        handleTcpQuery(socket, msg, clientIp);
      }
    });
    socket.on('timeout', () => socket.destroy());
    socket.on('error', () => {});
  });

  tcpServer.on('error', (e) => console.error('[resolver] TCP error:', e.message));
  tcpServer.listen(PORT, '0.0.0.0', () =>
    console.log(`[resolver] listening on TCP 0.0.0.0:${PORT}`));
}

function frame(msg) {
  const out = Buffer.alloc(2 + msg.length);
  out.writeUInt16BE(msg.length, 0);
  msg.copy(out, 2);
  return out;
}

function handleTcpQuery(socket, msg, clientIp) {
  if (isLoopback(clientIp) && tryHandleHealth(msg, (resp) => socket.write(frame(resp)))) {
    return;
  }
  if (isBlocked(clientIp)) {
    try { socket.write(frame(buildBlockedResponse(msg))); } catch {}
    return;
  }
  const up = net.connect(53, nextUpstream());
  up.setTimeout(QUERY_TIMEOUT);
  let rbuf = Buffer.alloc(0);

  up.on('connect', () => up.write(frame(msg)));
  up.on('data', (chunk) => {
    rbuf = Buffer.concat([rbuf, chunk]);
    if (rbuf.length >= 2) {
      const len = rbuf.readUInt16BE(0);
      if (rbuf.length >= 2 + len) {
        try { socket.write(rbuf.subarray(0, 2 + len)); } catch {}
        up.end();
      }
    }
  });
  up.on('timeout', () => up.destroy());
  up.on('error', () => {});
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

export function startResolver() {
  startUdp();
  startTcp();
}

// Close both listeners, releasing the port. Resolves after a short grace period
// so the port is free before a re-bind. The blocklist (module state) is untouched.
export function stopResolver() {
  return new Promise((resolve) => {
    const u = udpServer, t = tcpServer;
    udpServer = null;
    tcpServer = null;
    try { u && u.close(); } catch {}
    try { t && t.close(); } catch {}
    setTimeout(resolve, 800);
  });
}

// Used by the watchdog when the resolver stops responding.
export async function restartResolver() {
  await stopResolver();
  startResolver();
}

export function getResolverStatus() {
  return {
    ok: !!(udpServer && tcpServer),
    listening: PORT,
    upstreams: UPSTREAMS,
    blockedCount: blockedIps.size,
  };
}
