'use strict';

/**
 * Dependency-free test suite. Run with:  node backend/scheduler/costModel.test.js
 * Exits non-zero on first failure so it can gate CI.
 */

const assert = require('assert');
const {
  ATTACK_MODES,
  maskKeyspace,
  estimateKeyspace,
  estimateEtaSeconds,
  billableSeconds,
  placementCost,
  resolvePlacements,
  evaluatePlacements,
} = require('./costModel');
const { Scheduler, validateAuthorization } = require('./scheduler');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}\n      ${e.message}`);
    process.exitCode = 1;
    throw e;
  }
}

const providers = {
  electricity: { usdPerKwh: 0.20 },
  localDevices: [
    { id: 'local-cpu', kind: 'cpu', powerWatts: 100, available: true },
    { id: 'local-gpu', kind: 'gpu', powerWatts: 300, available: false },
  ],
  cloudInstances: [
    { id: 'rtx4090', kind: 'gpu', usdPerHour: 0.40, billingGranularitySeconds: 1, minBillableSeconds: 60, provisioningSeconds: 180, available: true },
    { id: 'h100', kind: 'gpu', usdPerHour: 3.0, billingGranularitySeconds: 1, minBillableSeconds: 60, provisioningSeconds: 300, available: true },
  ],
};

// ---- keyspace -------------------------------------------------------------
test('maskKeyspace expands ?-tokens and literals', () => {
  assert.strictEqual(maskKeyspace('?d?d?d?d'), 10000);
  assert.strictEqual(maskKeyspace('?u?l?l?l'), 26 * 26 * 26 * 26);
  assert.strictEqual(maskKeyspace('pre?d?d'), 100); // literals contribute factor 1
});

test('maskKeyspace honours custom charsets and rejects unknown tokens', () => {
  assert.strictEqual(maskKeyspace('?1?1', { 1: 62 }), 62 * 62);
  assert.throws(() => maskKeyspace('?z'), /Unknown mask charset/);
});

test('estimateKeyspace: dictionary multiplies by rules', () => {
  assert.strictEqual(
    estimateKeyspace({ attackMode: ATTACK_MODES.DICTIONARY, wordlistSize: 1e6, rulesCount: 64 }),
    64e6
  );
});

test('estimateKeyspace: explicit keyspace wins', () => {
  assert.strictEqual(estimateKeyspace({ explicitKeyspace: 42 }), 42);
});

test('estimateKeyspace: hybrid = wordlist x mask', () => {
  assert.strictEqual(
    estimateKeyspace({ attackMode: ATTACK_MODES.HYBRID_WM, wordlistSize: 1000, mask: '?d?d' }),
    1000 * 100
  );
});

// ---- eta + billing --------------------------------------------------------
test('estimateEtaSeconds divides keyspace by rate; Infinity when rate<=0', () => {
  assert.strictEqual(estimateEtaSeconds(1000, 500), 2);
  assert.strictEqual(estimateEtaSeconds(1000, 0), Infinity);
  assert.strictEqual(estimateEtaSeconds(0, 500), 0);
});

test('billableSeconds applies granularity and minimum', () => {
  assert.strictEqual(billableSeconds(5, { minBillableSeconds: 60 }), 60);
  assert.strictEqual(billableSeconds(90, { billingGranularitySeconds: 60 }), 120);
});

// ---- placement cost -------------------------------------------------------
test('local placement priced on electricity only', () => {
  const p = { id: 'local-cpu', location: 'local', powerWatts: 100 };
  const c = placementCost(p, 3600, { usdPerKwh: 0.20 }); // 1h at 100W = 0.1 kWh
  assert.ok(Math.abs(c.usd - 0.02) < 1e-9, `got ${c.usd}`);
  assert.strictEqual(c.wallClockSeconds, 3600);
});

test('cloud placement includes provisioning in cost and latency', () => {
  const p = { id: 'rtx4090', location: 'cloud', usdPerHour: 3600 / 3600, billingGranularitySeconds: 1, minBillableSeconds: 0, provisioningSeconds: 100 };
  // usdPerHour chosen = 1.0 ; eta 3600s=1h -> compute $1 ; prov 100s -> $0.0277...
  const c = placementCost(p, 3600, {});
  assert.ok(Math.abs(c.breakdown.computeUsd - 1.0) < 1e-9);
  assert.strictEqual(c.wallClockSeconds, 3700);
});

test('Infinity eta yields Infinity cost', () => {
  const c = placementCost({ location: 'cloud', usdPerHour: 1 }, Infinity, {});
  assert.strictEqual(c.usd, Infinity);
});

// ---- resolve + evaluate ---------------------------------------------------
test('resolvePlacements drops unavailable devices', () => {
  const ps = resolvePlacements(providers, {});
  const ids = ps.map((p) => p.id);
  assert.ok(ids.includes('local-cpu'));
  assert.ok(!ids.includes('local-gpu')); // available:false
  assert.ok(ids.includes('rtx4090') && ids.includes('h100'));
});

test('evaluate: no deadline -> cheapest feasible chosen (local CPU when fast enough)', () => {
  // Small keyspace; CPU slow but cheap, cloud fast but costs provisioning.
  const job = { keyspace: 1e6 };
  const hashRates = { 'local-cpu': 1e5, rtx4090: 1e9, h100: 5e9 };
  const r = evaluatePlacements(job, resolvePlacements(providers, hashRates), { usdPerKwh: 0.20 });
  // CPU: 10s @100W -> trivial cents of electricity; cloud pays >=60s min + provisioning.
  assert.strictEqual(r.chosen.placementId, 'local-cpu');
  assert.ok(r.chosen.usd < r.candidates.find((c) => c.placementId === 'rtx4090').usd);
});

test('evaluate: tight deadline forces a cloud GPU when CPU cannot finish in time', () => {
  const now = 1_000_000_000_000;
  const job = { keyspace: 1e12 };
  const hashRates = { 'local-cpu': 1e6, rtx4090: 2e9, h100: 1e10 };
  // CPU eta = 1e6 s (~11.5 days); deadline in 1 hour.
  const r = evaluatePlacements(job, resolvePlacements(providers, hashRates), {
    usdPerKwh: 0.20, nowMs: now, deadlineMs: now + 3600 * 1000,
  });
  assert.strictEqual(r.chosen.location, 'cloud');
  assert.strictEqual(r.chosen.meetsDeadline, true);
  // Of the two feasible cloud options, cheapest that still meets the deadline wins.
});

test('evaluate: impossible deadline -> fastest placement, flagged not feasible', () => {
  const now = 2_000_000_000_000;
  const job = { keyspace: 1e18 };
  const hashRates = { 'local-cpu': 1e6, rtx4090: 2e9, h100: 1e10 };
  const r = evaluatePlacements(job, resolvePlacements(providers, hashRates), {
    usdPerKwh: 0.20, nowMs: now, deadlineMs: now + 60 * 1000,
  });
  assert.strictEqual(r.chosen.placementId, 'h100'); // fastest
  assert.strictEqual(r.chosen.meetsDeadline, false);
});

// ---- authorization gating -------------------------------------------------
test('validateAuthorization rejects missing / unauthorized blocks', () => {
  assert.ok(validateAuthorization(undefined).length > 0);
  assert.ok(validateAuthorization({ authorized: false, basis: 'own-data', justification: 'my laptop backup' }).length > 0);
  assert.ok(validateAuthorization({ authorized: true, basis: 'bounty', justification: 'xxxxxxxx' }).length > 0);
  assert.ok(validateAuthorization({ authorized: true, basis: 'scoped-engagement', justification: 'pentest for acme' }).some((e) => /reference/.test(e)));
});

test('validateAuthorization accepts a complete own-data attestation', () => {
  assert.deepStrictEqual(
    validateAuthorization({ authorized: true, basis: 'own-data', justification: 'recovering my own KeePass db' }),
    []
  );
});

test('Scheduler.addJob refuses jobs without authorization', () => {
  const s = new Scheduler(providers);
  const r = s.addJob({ keyspace: 1000, hashRates: { 'local-cpu': 10 } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(s.jobs.size, 0);
});

test('Scheduler.plan orders by urgency and records placement', () => {
  const s = new Scheduler(providers);
  const now = Date.now();
  const auth = { authorized: true, basis: 'own-data', justification: 'my own archives' };
  // Urgent job: tight deadline. Background job: no deadline.
  s.addJob({ id: 'urgent', name: 'urgent', keyspace: 1e11, hashRates: { 'local-cpu': 1e6, rtx4090: 2e9, h100: 1e10 }, deadlineMs: now + 1800 * 1000, authorization: auth });
  s.addJob({ id: 'bg', name: 'background', keyspace: 1e6, hashRates: { 'local-cpu': 1e5, rtx4090: 1e9, h100: 5e9 }, authorization: auth });
  const plan = s.plan(now);
  assert.strictEqual(plan[0].jobId, 'urgent'); // deadline pressure ranks it first
  assert.ok(plan[0].chosenPlacement);
  assert.ok(typeof plan[0].score === 'number');
});

console.log(`\n${passed} checks passed.`);
