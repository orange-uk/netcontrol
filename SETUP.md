# Network Control — Setup Guide

## Overview

A mobile-friendly web app to block/unblock internet access for groups of devices
(Smart TV, Apple TV, Sky box, etc.) on your home network, on demand or on a schedule.

**How it works:**
1. netcontrol runs a **built-in DNS resolver** directly on your Mac (no Docker, no
   Pi-hole, no VM). Because it runs natively, it sees the **real source IP** of every
   client query.
2. Your router hands out your Mac's IP as the DNS server to all devices.
3. When a device's group is "blocked", the resolver answers `0.0.0.0` for that
   device's IP — so it gets no working internet. Every other query is forwarded to
   the upstream resolvers (Google DNS by default) and returned normally.
4. The same Node.js process serves the web app and runs the scheduler.

> **Why native, not Pi-hole-in-Docker?** Docker Desktop on macOS runs containers in
> a Linux VM, so the container only ever sees the VM's gateway IP (e.g. 172.17.0.1),
> never the real client IP — which makes per-device blocking impossible. Bridged VM
> networking can preserve client IPs, but only over a NIC that supports promiscuous
> mode (this Mac's LAN is on a USB adapter that doesn't). Running the resolver
> natively sidesteps all of that.

---

## Prerequisites

- Mac that stays on (Ethernet preferred), with a **static IP** on your LAN
- Node.js 18+ (`/usr/local/bin/node`) — check with `node --version`
- Admin (sudo) access on the Mac — the resolver binds port 53, which requires root

---

## Step 1 — Make the Mac's IP static

Find it: `ipconfig getifaddr en8` (this Mac's LAN is on the USB Ethernet adapter `en8`;
yours may be `en0`). In your router (http://192.168.1.1), add a **DHCP reservation** so
the Mac always gets the same IP (e.g. `192.168.1.178`).

---

## Step 2 — Install the app

```bash
cd "/Users/niekmeijer/netcontrol"
npm install                            # express, node-cron, dns-packet
mkdir -p logs data
cp src/config.example.js src/config.js # then edit config.js (it's gitignored)
```

### Configure (`src/config.js`)

`config.js` is gitignored so your PIN never lands in version control. Set the PIN
there, or supply it via the `NETCONTROL_PIN` env var in the LaunchDaemon.

```js
export const config = {
  pin: process.env.NETCONTROL_PIN || '1234',   // change this
  port: Number(process.env.PORT) || 3000,
  resolver: {
    port: Number(process.env.NETCONTROL_DNS_PORT) || 53,
    upstreams: ['8.8.8.8', '8.8.4.4'],
    blockTTL: 60,
    queryTimeoutMs: 5000,
    watchdogIntervalMs: Number(process.env.NETCONTROL_WATCHDOG_MS) || 30000,
    watchdogProbeTimeoutMs: Number(process.env.NETCONTROL_WATCHDOG_PROBE_MS) || 2000,
  },
  dataFile: process.env.DATA_FILE || './data/state.json',
};
```

`PORT` / `NETCONTROL_DNS_PORT` / `DATA_FILE` env vars let you run a test instance on
unprivileged ports without touching the live service or its state.

### Quick local test (no root needed)

```bash
PORT=3099 NETCONTROL_DNS_PORT=5354 DATA_FILE=/tmp/nc-test.json npm start
# elsewhere:
dig google.com @127.0.0.1 -p 5354     # forwards -> real IPs
```

---

## Step 3 — Run as a root LaunchDaemon (binds port 53)

The resolver must bind port 53, which requires root, so netcontrol runs as a
**LaunchDaemon** (`/Library/LaunchDaemons`), not a user LaunchAgent.

A helper script does the migration (stops any old user agent, installs the daemon,
starts it, and verifies):

```bash
bash ~/netcontrol-deploy.sh      # asks for your password once
```

It should end with `DEPLOY_DONE`, show `node` listening on UDP/TCP `:53`, and a healthy
`/api/status`. To manage it afterwards:

```bash
sudo launchctl kickstart -k system/uk.co.netcontrol.server   # restart
sudo launchctl bootout   system/uk.co.netcontrol.server      # stop
tail -f "/Users/niekmeijer/netcontrol/logs/server.log"
```

---

## Step 4 — Point your router's DNS at the Mac

Router → LAN/DHCP settings:
- **Primary DNS** = your Mac's IP (e.g. `192.168.1.178`)
- **Secondary DNS** = leave blank, or set it to the Mac too. **Do not** set a public
  resolver (e.g. `8.8.8.8`) as secondary — devices would bypass blocking by using it.

Devices pick up the new DNS on their next DHCP renewal (toggle Wi-Fi to force it).

---

## Step 5 — Add devices (each needs a static IP)

Per-device blocking keys on the device's **IP address**, so give each device a DHCP
reservation in the router, then add it in the app with its name, MAC, and that IP.

---

## Using the app

1. Open `http://192.168.1.178:3000` on any device on the LAN; enter your PIN.
2. **Add a group** (e.g. "Front Room TV") and **add devices** (name, MAC, static IP).
3. **Toggle** a group off to block its devices immediately.
4. **Add a schedule** (days + block/allow times); the scheduler enforces it each minute.

### Manual override
Toggling a group manually sets a "manual override" so the scheduler won't change it.
Tap "Resume schedule" to hand control back to the schedule.

### Verifying a block
Blocking is by **source IP**, so test **from the blocked device itself**:

```bash
# on the blocked device (e.g. 192.168.1.126):
dig google.com @192.168.1.178      # -> 0.0.0.0 when its group is blocked
```

Running `dig` from the Mac won't show as blocked — the query's source would be the
Mac's own IP, not the device's.

---

## Troubleshooting

**Device still has internet when blocked**
- Confirm it's actually using the Mac for DNS (device network settings).
- Confirm the device's IP in the app matches its real IP (check the router lease).
- Some devices cache DNS or hard-code `8.8.8.8` — power-cycle; ensure the router
  hands out only the Mac as DNS.
- Check the resolver sees it: `curl -s http://192.168.1.178:3000/api/status`
  (shows `blocked` count) and `logs/server.log` (logs the blocklist on each change).

**Resolver not on port 53**
- `sudo lsof -nP -iUDP:53` should show `node`. If not, check `logs/server-error.log`
  (e.g. `EADDRINUSE` = something else owns 53; `EACCES` = not running as root).

**App unreachable from other devices**
- macOS firewall: allow incoming connections for `node` (port 3000).

**Schedule not firing**
- `tail -f logs/server.log`; confirm the Mac's timezone with `date`.
