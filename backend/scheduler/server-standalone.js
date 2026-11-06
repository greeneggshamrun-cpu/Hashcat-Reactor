'use strict';

/**
 * Standalone HTTP service for the cost-aware scheduler, suitable for hosting on
 * its own (e.g. a DigitalOcean App Platform app or a droplet) separately from
 * the full Electron desktop app.
 *
 * It exposes ONLY the scheduler planning API (/api/scheduler/*) plus a health
 * check. It computes plans; it does not run hashcat and does not provision any
 * cloud instances. It performs no marketplace/escrow I/O.
 *
 * Run:   node backend/scheduler/server-standalone.js
 * Env:   PORT (default 8080), SCHED_USD_PER_KWH (optional override)
 */

const express = require('express');
const createSchedulerRouter = require('./router');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => res.json({ ok: true, service: 'cost-aware-scheduler' }));
app.get('/', (_req, res) =>
  res.json({ service: 'cost-aware-scheduler', endpoints: ['/health', '/api/scheduler/*'] })
);

const routerOpts = {};
if (process.env.SCHED_USD_PER_KWH) {
  routerOpts.usdPerKwh = Number(process.env.SCHED_USD_PER_KWH);
}
app.use('/api/scheduler', createSchedulerRouter(routerOpts));

const port = Number(process.env.PORT) || 8080;
// Bind 0.0.0.0 so it works inside containers / App Platform.
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`[scheduler] standalone service listening on :${port}`);
});

// Graceful shutdown for container platforms.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`[scheduler] ${sig} received, shutting down`);
    server.close(() => process.exit(0));
  });
}

module.exports = app;
