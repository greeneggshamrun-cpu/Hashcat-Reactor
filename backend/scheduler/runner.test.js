'use strict';

/**
 * Tests for the supervised execution runner. Mock adapter; no network.
 * Run:  node backend/scheduler/runner.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Runner } = require('./runner');
const { Scheduler } = require('./scheduler');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; throw e; }
}

const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-')), 'a.jsonl');
const auth = { authorized: true, basis: 'own-data', justification: 'recovering my own archive' };

// providers with a cheap cloud GPU so a tight-deadline job picks cloud.
const providers = {
  electricity: { usdPerKwh: 0.2 },
  budget: { maxJobUsd: 25, maxPlanUsd: 100 },
  localDevices: [{ id: 'local-cpu', kind: 'cpu', powerWatts: 100, available: true }],
  cloudInstances: [{ id: 'gpu', kind: 'gpu', usdPerHour: 0.5, billingGranularitySeconds: 1, minBillableSeconds: 60, provisioningSeconds: 60, available: true }],
};

function mkScheduler() { return new Scheduler(providers, { auditOpts: { logPath } }); }

// Mock adapter records calls and simulates an instance lifecycle.
function mockAdapter(opts = {}) {
  const calls = [];
  let activeChecks = 0;
  return {
    name: 'mock',
    calls,
    run: async (job, o) => {
      calls.push({ fn: 'run', jobId: job.id, confirm: o.confirm, estimatedUsd: o.estimatedUsd });
      if (!o.confirm) return { dryRun: true, plan: { willSpend: true } };
      return { dryRun: false, instance: { id: 'i-mock' } };
    },
    refOf: (res) => res.instance && res.instance.id,
    isActive: async () => { activeChecks++; return activeChecks < (opts.activeFor || 2); },
    teardown: async (id) => { calls.push({ fn: 'teardown', id }); return { terminated: id }; },
  };
}

(async () => {
  await test('nextEligible picks the top in-budget feasible job', () => {
    const s = mkScheduler();
    const now = Date.now();
    s.addJob({ id: 'cloudy', name: 'cloudy', keyspace: 1e10, hashRates: { 'local-cpu': 1e5, gpu: 1e9 }, deadlineMs: now + 1800 * 1000, authorization: auth });
    const r = new Runner({ scheduler: s, adapter: mockAdapter() });
    const pick = r.nextEligible(now);
    assert.strictEqual(pick.job.id, 'cloudy');
  });

  await test('runNext dry-run does not change status or spend', async () => {
    const s = mkScheduler();
    const now = Date.now();
    s.addJob({ id: 'j', name: 'j', keyspace: 1e10, hashRates: { 'local-cpu': 1e5, gpu: 1e9 }, deadlineMs: now + 1800 * 1000, authorization: auth });
    const a = mockAdapter();
    const r = new Runner({ scheduler: s, adapter: a, confirm: false });
    const out = await r.runNext(now);
    assert.strictEqual(out.dryRun, true);
    assert.strictEqual(s.getJob('j').status, 'planned'); // not running
    assert.ok(a.calls.find((c) => c.fn === 'run' && c.confirm === false));
  });

  await test('runNext confirm provisions, marks running, feeds estimatedUsd to budget', async () => {
    const s = mkScheduler();
    const now = Date.now();
    s.addJob({ id: 'j', name: 'j', keyspace: 1e10, hashRates: { 'local-cpu': 1e5, gpu: 1e9 }, deadlineMs: now + 1800 * 1000, authorization: auth });
    const a = mockAdapter();
    const r = new Runner({ scheduler: s, adapter: a, confirm: true });
    const out = await r.runNext(now);
    assert.strictEqual(out.dryRun, false);
    assert.strictEqual(out.ref, 'i-mock');
    assert.strictEqual(s.getJob('j').status, 'running');
    const runCall = a.calls.find((c) => c.fn === 'run' && c.confirm === true);
    assert.ok(typeof runCall.estimatedUsd === 'number', 'modeled cost passed to the budget guard');
  });

  await test('over-budget job is skipped by nextEligible', () => {
    const pricey = {
      electricity: { usdPerKwh: 0.2 }, budget: { maxJobUsd: 0.001, maxPlanUsd: 100 },
      localDevices: [{ id: 'local-cpu', kind: 'cpu', powerWatts: 100, available: true }],
      cloudInstances: [{ id: 'gpu', kind: 'gpu', usdPerHour: 50, billingGranularitySeconds: 1, minBillableSeconds: 60, provisioningSeconds: 60, available: true }],
    };
    const s = new Scheduler(pricey, { auditOpts: { logPath } });
    const now = Date.now();
    s.addJob({ id: 'big', name: 'big', keyspace: 1e12, hashRates: { 'local-cpu': 1e5, gpu: 1e9 }, deadlineMs: now + 600 * 1000, authorization: auth });
    const r = new Runner({ scheduler: s, adapter: mockAdapter() });
    assert.strictEqual(r.nextEligible(now), null, 'over-budget job not eligible');
  });

  await test('local placement marks running without provisioning', async () => {
    const s = mkScheduler();
    s.addJob({ id: 'loc', name: 'loc', keyspace: 1000, hashRates: { 'local-cpu': 1e6 }, authorization: auth }); // no deadline -> cheap local
    const a = mockAdapter();
    const r = new Runner({ scheduler: s, adapter: a, confirm: true });
    const out = await r.runNext();
    assert.strictEqual(out.local, true);
    assert.strictEqual(s.getJob('loc').status, 'running');
    assert.ok(!a.calls.some((c) => c.fn === 'run'), 'no cloud provisioning for a local job');
  });

  await test('watch polls until inactive then marks done', async () => {
    const s = mkScheduler();
    s.addJob({ id: 'w', name: 'w', keyspace: 1000, hashRates: { 'local-cpu': 1e6 }, authorization: auth });
    s.setStatus('w', 'running');
    const a = mockAdapter({ activeFor: 3 });
    const r = new Runner({ scheduler: s, adapter: a });
    const out = await r.watch('w', 'i-mock', { intervalMs: 1, sleep: () => Promise.resolve() });
    assert.strictEqual(out.done, true);
    assert.strictEqual(s.getJob('w').status, 'done');
  });

  await test('runNext on empty queue reports done', async () => {
    const s = mkScheduler();
    const r = new Runner({ scheduler: s, adapter: mockAdapter() });
    const out = await r.runNext();
    assert.strictEqual(out.done, true);
  });

  console.log(`\n${passed} checks passed.`);
})().catch(() => process.exit(1));
