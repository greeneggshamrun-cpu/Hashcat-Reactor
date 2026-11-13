'use strict';

/**
 * Tests for live pricing and the spot-interruption / hardening run-script bits.
 * Mocked; no AWS, no network.  Run: node backend/scheduler/pricing.test.js
 */

const assert = require('assert');
const { awsSpotPrice, doSizePrice } = require('./pricing');
const { generateRunScript } = require('./providers/runScript');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; throw e; }
}

const job = { name: 'my own archive', authorization: { basis: 'own-data' } };

(async () => {
  await test('awsSpotPrice returns the cheapest AZ price', async () => {
    const exec = async (args) => {
      assert.ok(args.includes('describe-spot-price-history'));
      return { SpotPriceHistory: [
        { AvailabilityZone: 'us-east-1a', SpotPrice: '0.45' },
        { AvailabilityZone: 'us-east-1b', SpotPrice: '0.39' },
        { AvailabilityZone: 'us-east-1a', SpotPrice: '0.50' },
      ] };
    };
    const r = await awsSpotPrice('g4dn.xlarge', { exec, region: 'us-east-1' });
    assert.strictEqual(r.cheapestUsdPerHour, 0.39);
    assert.strictEqual(r.byAz['us-east-1b'], 0.39);
  });

  await test('awsSpotPrice throws when no history', async () => {
    await assert.rejects(() => awsSpotPrice('x', { exec: async () => ({ SpotPriceHistory: [] }) }), /no spot price/);
  });

  await test('doSizePrice reads the slug price from providers', () => {
    const providers = { cloudInstances: [{ id: 'gpu-h100x1-80gb', usdPerHour: 2.9 }] };
    assert.strictEqual(doSizePrice(providers, 'gpu-h100x1-80gb'), 2.9);
    assert.strictEqual(doSizePrice(providers, 'nope'), null);
  });

  await test('run script hardening: umask 077 present', () => {
    assert.ok(/umask 077/.test(generateRunScript(job, {})));
  });

  await test('spotAware adds an IMDSv2 interruption watcher; default omits it', () => {
    const spot = generateRunScript(job, { spotAware: true });
    assert.ok(/spot\/instance-action/.test(spot), 'watches the spot interruption endpoint');
    assert.ok(/X-aws-ec2-metadata-token/.test(spot), 'uses IMDSv2 token');
    assert.ok(/--restore/.test(spot), 'mentions resumable --restore');
    const plain = generateRunScript(job, {});
    assert.ok(!/spot\/instance-action/.test(plain), 'no watcher without spotAware');
  });

  console.log(`\n${passed} checks passed.`);
})().catch(() => process.exit(1));
