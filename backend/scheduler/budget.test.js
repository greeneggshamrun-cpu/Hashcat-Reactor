'use strict';

/**
 * Tests for the budget guard and the audit log, plus their integration with
 * the scheduler and provisioners. No network.
 * Run:  node backend/scheduler/budget.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { checkJobBudget, assertJobBudget, checkPlanBudget } = require('./budget');
const { appendAudit, readAudit, redact } = require('./audit');
const { Scheduler } = require('./scheduler');
const doProvider = require('./providers/digitalocean');
const awsProvider = require('./providers/aws');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; throw e; }
}

const auth = { authorized: true, basis: 'own-data', justification: 'recovering my own archive' };

// ---- budget math ----------------------------------------------------------
(async () => {
  await test('no cap -> always ok', () => {
    assert.strictEqual(checkJobBudget({ estimatedUsd: 9999, maxUsd: null }).ok, true);
  });
  await test('within cap ok; over cap refused', () => {
    assert.strictEqual(checkJobBudget({ estimatedUsd: 5, maxUsd: 25 }).ok, true);
    assert.strictEqual(checkJobBudget({ estimatedUsd: 40, maxUsd: 25 }).ok, false);
  });
  await test('cap set but no figure -> fail-safe refuse', () => {
    const r = checkJobBudget({ maxUsd: 25 });
    assert.strictEqual(r.ok, false);
    assert.ok(/no cost estimate/.test(r.reason));
  });
  await test('worst-case used when no estimate', () => {
    assert.strictEqual(checkJobBudget({ worstCaseUsd: 10, maxUsd: 25 }).ok, true);
    assert.strictEqual(checkJobBudget({ worstCaseUsd: 30, maxUsd: 25 }).ok, false);
  });
  await test('assertJobBudget throws over cap', () => {
    assert.throws(() => assertJobBudget({ estimatedUsd: 40, maxUsd: 25 }), /Budget cap/);
  });
  await test('plan budget aggregate', () => {
    assert.strictEqual(checkPlanBudget({ totalUsd: 50, maxPlanUsd: 100 }).ok, true);
    assert.strictEqual(checkPlanBudget({ totalUsd: 150, maxPlanUsd: 100 }).ok, false);
  });

  // ---- audit log ----------------------------------------------------------
  const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'audit-')), 'a.jsonl');

  await test('appendAudit writes JSONL and readAudit returns it', () => {
    appendAudit({ event: 'job.added', jobId: 'j1' }, { logPath });
    appendAudit({ event: 'provision.launched', jobId: 'j1' }, { logPath });
    const rows = readAudit({ logPath });
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].event, 'job.added');
    assert.ok(rows[0].ts, 'has a timestamp');
  });

  await test('audit redacts secret-looking keys', () => {
    const r = redact({ token: 'abc', nested: { api_key: 'x', basis: 'own-data' } });
    assert.strictEqual(r.token, '[redacted]');
    assert.strictEqual(r.nested.api_key, '[redacted]');
    assert.strictEqual(r.nested.basis, 'own-data');
  });

  // ---- scheduler integration ---------------------------------------------
  await test('scheduler flags over-budget jobs in the plan', () => {
    const providers = {
      electricity: { usdPerKwh: 0.2 },
      budget: { maxJobUsd: 1, maxPlanUsd: 100 },
      localDevices: [{ id: 'local-cpu', kind: 'cpu', powerWatts: 100, available: true }],
      cloudInstances: [{ id: 'h100', kind: 'gpu', usdPerHour: 100, billingGranularitySeconds: 1, minBillableSeconds: 60, provisioningSeconds: 300, available: true }],
    };
    const s = new Scheduler(providers, { auditOpts: { logPath } });
    // Force an expensive cloud-only job: CPU can't finish before a tight deadline.
    const now = Date.now();
    s.addJob({ id: 'pricey', name: 'pricey', keyspace: 1e15, hashRates: { 'local-cpu': 1e5, h100: 1e9 }, deadlineMs: now + 600 * 1000, authorization: auth });
    const res = s.planWithBudget(now);
    assert.strictEqual(res.plan[0].overBudget, true, 'expensive job flagged');
    assert.ok(res.budget.overBudgetJobs.includes('pricey'));
  });

  await test('scheduler.addJob writes an audit entry with authorization snapshot', () => {
    const before = readAudit({ logPath }).length;
    const providers = { electricity: { usdPerKwh: 0.2 }, localDevices: [{ id: 'local-cpu', kind: 'cpu', powerWatts: 100, available: true }], cloudInstances: [] };
    const s = new Scheduler(providers, { auditOpts: { logPath } });
    s.addJob({ id: 'audited', name: 'audited', keyspace: 1000, hashRates: { 'local-cpu': 10 }, authorization: auth });
    const rows = readAudit({ logPath });
    assert.ok(rows.length > before);
    const entry = rows.reverse().find((r) => r.jobId === 'audited');
    assert.strictEqual(entry.authorization.basis, 'own-data');
    assert.ok(entry.authorization.justification);
  });

  // ---- provisioner integration -------------------------------------------
  const goodJob = { id: 'p1', name: 'my own archive', authorization: auth };

  await test('DO: launch refused when worst-case exceeds the cap', async () => {
    const calls = [];
    const http = async ({ method, url, body }) => {
      calls.push(method + ' ' + url);
      if (method === 'POST') return { status: 202, json: { droplet: { id: 1, name: body.name, status: 'new', tags: body.tags } } };
      return { status: 200, json: {} };
    };
    await assert.rejects(
      () => doProvider.runAuthorizedJob(goodJob, {
        confirm: true, _token: 'tkn', httpRequest: http,
        maxUsd: 5, sizeUsdPerHour: 10, maxLifetimeMinutes: 120, // worst case = $20 > $5
        auditOpts: { logPath },
      }),
      /Budget cap/
    );
    assert.ok(!calls.some((c) => c.startsWith('POST')), 'no droplet created when over budget');
  });

  await test('DO: launch allowed when estimate is under the cap', async () => {
    const http = async ({ method, url, body }) => {
      if (method === 'POST') return { status: 202, json: { droplet: { id: 2, name: body.name, status: 'new', tags: body.tags } } };
      return { status: 200, json: {} };
    };
    const res = await doProvider.runAuthorizedJob(goodJob, {
      confirm: true, _token: 'tkn', httpRequest: http,
      maxUsd: 25, estimatedUsd: 3, auditOpts: { logPath },
    });
    assert.strictEqual(res.dryRun, false);
    assert.strictEqual(res.droplet.id, 2);
  });

  await test('AWS: launch refused when worst-case exceeds the cap', async () => {
    const exec = async (args) => {
      if (args[1] === 'get-caller-identity') return { Account: '1', Arn: 'a' };
      if (args[1] === 'run-instances') return { Instances: [{ InstanceId: 'i-x', InstanceType: 'g4dn.xlarge', State: { Name: 'pending' } }] };
      return {};
    };
    await assert.rejects(
      () => awsProvider.runAuthorizedJob(goodJob, {
        confirm: true, exec, maxUsd: 1, instanceUsdPerHour: 5, maxLifetimeMinutes: 120, // $10 > $1
        auditOpts: { logPath },
      }),
      /Budget cap/
    );
  });

  await test('provision dry-run and launch are recorded in the audit log', () => {
    const rows = readAudit({ logPath });
    assert.ok(rows.some((r) => r.event === 'provision.refused'), 'refusals audited');
    assert.ok(rows.some((r) => r.event === 'provision.launched'), 'launches audited');
  });

  console.log(`\n${passed} checks passed.`);
})().catch(() => process.exit(1));
