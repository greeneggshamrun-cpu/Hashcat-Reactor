'use strict';

/**
 * Tests for job persistence and benchmark parsing. No network, no hashcat.
 * Run:  node backend/scheduler/store.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadJobs, saveJobs } = require('./store');
const { parseMachineReadable, benchmarkMode, toHashRates } = require('./benchmark');
const { Scheduler } = require('./scheduler');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; throw e; }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
const storePath = path.join(tmpDir, 'jobs.json');
const auth = { authorized: true, basis: 'own-data', justification: 'recovering my own archive' };
const providers = { electricity: { usdPerKwh: 0.2 }, localDevices: [{ id: 'local-cpu', kind: 'cpu', powerWatts: 100, available: true }], cloudInstances: [] };

(async () => {
  await test('saveJobs then loadJobs round-trips', () => {
    const r = saveJobs([{ id: 'a', name: 'x' }], { storePath });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(loadJobs({ storePath }).map((j) => j.id), ['a']);
  });

  await test('loadJobs returns [] for a missing/garbage file', () => {
    assert.deepStrictEqual(loadJobs({ storePath: path.join(tmpDir, 'nope.json') }), []);
    fs.writeFileSync(path.join(tmpDir, 'bad.json'), '{not json');
    assert.deepStrictEqual(loadJobs({ storePath: path.join(tmpDir, 'bad.json') }), []);
  });

  await test('scheduler persists jobs and a fresh instance reloads them', () => {
    const s1 = new Scheduler(providers, { storePath, auditOpts: { logPath: path.join(tmpDir, 'a.jsonl') } });
    s1.addJob({ id: 'persisted', name: 'persisted', keyspace: 1000, hashRates: { 'local-cpu': 10 }, authorization: auth });
    // New instance pointed at the same store should see the job.
    const s2 = new Scheduler(providers, { storePath, auditOpts: { logPath: path.join(tmpDir, 'a.jsonl') } });
    assert.ok(s2.getJob('persisted'), 'job reloaded from disk');
  });

  await test('cancel + setStatus persist', () => {
    const s = new Scheduler(providers, { storePath: path.join(tmpDir, 's2.json'), auditOpts: { logPath: path.join(tmpDir, 'a.jsonl') } });
    s.addJob({ id: 'j', name: 'j', keyspace: 1000, hashRates: { 'local-cpu': 10 }, authorization: auth });
    s.setStatus('j', 'running');
    assert.strictEqual(loadJobs({ storePath: path.join(tmpDir, 's2.json') })[0].status, 'running');
    s.cancelJob('j'); // running jobs can't cancel; status stays running
    assert.strictEqual(loadJobs({ storePath: path.join(tmpDir, 's2.json') })[0].status, 'running');
  });

  await test('no persistence by default (no file written)', () => {
    const p = path.join(tmpDir, 'should-not-exist.json');
    const s = new Scheduler(providers, { auditOpts: { logPath: path.join(tmpDir, 'a.jsonl') } });
    s.addJob({ id: 'ephemeral', name: 'e', keyspace: 1000, hashRates: { 'local-cpu': 10 }, authorization: auth });
    assert.strictEqual(fs.existsSync(p), false);
  });

  // ---- benchmark parsing --------------------------------------------------
  await test('parseMachineReadable sums per-device speeds', () => {
    const out = '1:0:0:0:12000000000\n2:0:0:0:8000000000\n';
    const r = parseMachineReadable(out);
    assert.strictEqual(r.totalHps, 20000000000);
    assert.strictEqual(r.perDevice['1'], 12000000000);
    assert.strictEqual(r.perDevice['2'], 8000000000);
  });

  await test('parseMachineReadable ignores non-benchmark lines', () => {
    const r = parseMachineReadable('garbage\n\n1:0:0:0:500\n# comment');
    assert.strictEqual(r.totalHps, 500);
  });

  await test('benchmarkMode uses injected exec and returns H/s', async () => {
    const exec = async (args) => {
      assert.ok(args.includes('-m') && args.includes('0'), 'passes the hash mode');
      return '1:0:0:0:1000000\n';
    };
    const r = await benchmarkMode(0, { exec });
    assert.strictEqual(r.totalHps, 1000000);
    assert.strictEqual(r.hashMode, 0);
  });

  await test('benchmarkMode throws when no usable speed parsed', async () => {
    await assert.rejects(() => benchmarkMode(0, { exec: async () => 'nothing useful' }), /no usable speed/);
  });

  await test('toHashRates fans a measured speed across placements with optional scale', () => {
    const m = toHashRates(1e9, ['local-gpu', 'rtx4090-1x'], { 'rtx4090-1x': 1.5 });
    assert.strictEqual(m['local-gpu'], 1e9);
    assert.strictEqual(m['rtx4090-1x'], 1.5e9);
  });

  console.log(`\n${passed} checks passed.`);
})().catch(() => process.exit(1));
