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

// Optional API-key auth. If SCHEDULER_API_KEY is set, every /api/* request must
// send a matching key (Authorization: Bearer <key>, or X-Api-Key: <key>). The
// service is public by default on App Platform, so set this when exposing it.
// Compared in constant time to avoid leaking the key via timing.
const crypto = require('crypto');
const API_KEY = process.env.SCHEDULER_API_KEY || '';
if (!API_KEY) {
  console.warn('[scheduler] SCHEDULER_API_KEY not set — /api is UNAUTHENTICATED. Set it before exposing this service.');
}
function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
app.use('/api', (req, res, next) => {
  if (!API_KEY) return next(); // auth disabled
  const hdr = req.get('authorization') || '';
  const bearer = hdr.startsWith('Bearer ') ? hdr.slice(7) : '';
  const presented = bearer || req.get('x-api-key') || '';
  if (presented && timingSafeEqual(presented, API_KEY)) return next();
  res.set('WWW-Authenticate', 'Bearer');
  return res.status(401).json({ message: 'Unauthorized: missing or invalid API key' });
});

const routerOpts = {};
if (process.env.SCHED_USD_PER_KWH) {
  routerOpts.usdPerKwh = Number(process.env.SCHED_USD_PER_KWH);
}
app.use('/api/scheduler', createSchedulerRouter(routerOpts));

// Only start listening when run directly (node server-standalone.js), so the
// app can be imported by tests without binding a port or registering signal
// handlers.
if (require.main === module) {
  const port = Number(process.env.PORT) || 8080;
  // Bind 0.0.0.0 so it works inside containers / App Platform.
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`[scheduler] standalone service listening on :${port}`);
  });
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      console.log(`[scheduler] ${sig} received, shutting down`);
      server.close(() => process.exit(0));
    });
  }
}

module.exports = app;
