'use strict';

/**
 * Smoke test for the standalone service, including API-key auth.
 * Boots the app on an ephemeral port with SCHEDULER_API_KEY set and checks:
 *   - /health needs no key
 *   - /api/* without a key -> 401
 *   - /api/* with the wrong key -> 401
 *   - /api/* with the right key -> 200
 *   - provision-plan over HTTP stays dryRun even if confirm:true is sent
 *
 * Requires express (installed in backend/scheduler for this test).
 * Run:  node backend/scheduler/server.smoke.test.js
 */

const http = require('http');
const assert = require('assert');

const KEY = 'test-key-123';
process.env.SCHEDULER_API_KEY = KEY;

// Imported without side effects (it only auto-listens when run directly).
const app = require('./server-standalone');

function req(port, path, { method = 'GET', key, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (key) headers.Authorization = `Bearer ${key}`;
    const r = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

(async () => {
  // Start a listener on the imported app on an ephemeral port.
  const server = http.createServer(app).listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;

  let passed = 0;
  const check = (name, cond) => {
    assert.ok(cond, name);
    passed++;
    console.log(`  ok  ${name}`);
  };

  const health = await req(port, '/health');
  check('/health needs no key (200)', health.status === 200);

  const noKey = await req(port, '/api/scheduler/providers');
  check('/api without key -> 401', noKey.status === 401);

  const badKey = await req(port, '/api/scheduler/providers', { key: 'wrong' });
  check('/api with wrong key -> 401', badKey.status === 401);

  const good = await req(port, '/api/scheduler/providers', { key: KEY });
  check('/api with right key -> 200', good.status === 200);

  // Add a job, then confirm provision-plan stays a dry run over HTTP.
  const add = await req(port, '/api/scheduler/jobs', {
    method: 'POST', key: KEY,
    body: {
      id: 'smoke', name: 'my own archive', attackMode: 0, wordlistSize: 1e6, rulesCount: 1,
      hashRates: { 'local-cpu': 3000 },
      authorization: { authorized: true, basis: 'own-data', justification: 'recovering my own archive' },
    },
  });
  check('add authorized job -> 201', add.status === 201);

  const plan = await req(port, '/api/scheduler/jobs/smoke/provision-plan', {
    method: 'POST', key: KEY, body: { confirm: true, size: 'gpu-h100x1-80gb' },
  });
  const planJson = JSON.parse(plan.body);
  check('provision-plan ignores confirm:true (stays dryRun)', planJson.dryRun === true && !('droplet' in planJson));

  console.log(`\n${passed} checks passed.`);
  server.close();
  process.exit(0);
})().catch((e) => {
  console.error('FAIL', e.message);
  process.exit(1);
});
