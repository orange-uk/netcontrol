// netcontrol/src/server.js

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { loginHandler, logoutHandler, requireAuth } from './routes/auth.js';
import groupsRouter from './routes/groups.js';
import { startScheduler } from './scheduler/index.js';
import { startResolver } from './resolver/index.js';
import { startWatchdog } from './resolver/watchdog.js';
import { getStatus, rebuildBlocklist } from './resolver/control.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());

// Serve the frontend from /public
app.use(express.static(path.join(__dirname, '../public')));

// Auth
app.post('/api/auth/login', loginHandler);
app.post('/api/auth/logout', requireAuth, logoutHandler);

// Groups, devices, schedules
app.use('/api/groups', groupsRouter);

// DNS resolver health check
app.get('/api/status', async (req, res) => {
  const resolver = await getStatus();
  res.json({ ok: true, resolver });
});

// Fallback: serve index.html for any unknown route (SPA)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(config.port, '0.0.0.0', () => {
  console.log(`[server] Network Control running at http://0.0.0.0:${config.port}`);
  console.log(`[server] Access on local network: http://<your-mac-ip>:${config.port}`);
});

// Start the native DNS resolver and seed its blocklist from saved state.
startResolver();
rebuildBlocklist();

// Watchdog: probe the resolver every 30s; log + auto-restart if it stops answering.
startWatchdog();

startScheduler();
