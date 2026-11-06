'use strict';

/**
 * Mocked tests for the DigitalOcean provisioner. No network.
 * Run:  node backend/scheduler/providers/digitalocean.test.js
 */

const assert = require('assert');
const {
  DigitalOceanProvisioner,
  runAuthorizedJob,
  generateRunScript,
  MANAGED_TAG,
} = require('./digitalocean');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}\n      ${e.message}`);
    process.exitCode = 1;
    throw e;
  }
}

const goodJob = {
  id: 'job_abc',
  name: 'Recover my own KeePass master',
  authorization: { authorized: true, basis: 'own-data', justification: 'recovering my own KeePass db' },
};

// A fake HTTP client that records calls and returns canned droplet responses.
function makeFakeHttp(script = {}) {
  const calls = [];
  const http = async ({ method, url, token, body }) => {
    calls.push({ method, url, token, body });
    if (method === 'POST' && url.endsWith('/v2/droplets')) {
      return { status: 202, json: { droplet: { id: 777, name: body.name, status: 'new', tags: body.tags } } };
    }
    if (method === 'GET' && /\/v2\/droplets\/\d+$/.test(url)) {
      const status = script.activateImmediately ? 'active' : 'new';
      return { status: 200, json: { droplet: { id: 777, status } } };
    }
    if (method === 'GET' && url.includes('tag_name=')) {
      return { status: 200, json: { droplets: [{ id: 777, tags: [MANAGED_TAG] }] } };
    }
    if (method === 'DELETE') {
      return { status: 204, json: null };
    }
    return { status: 404, json: { message: 'not found' } };
  };
  return { http, calls };
}

(async () => {
  await test('dry run by default: no token needed, no network call', async () => {
    const { http, calls } = makeFakeHttp();
    const res = await runAuthorizedJob(goodJob, { httpRequest: http /* no confirm, no token */ });
    assert.strictEqual(res.dryRun, true);
    assert.strictEqual(calls.length, 0, 'dry run must not touch the API');
    assert.ok(res.plan.runScript.includes('reactor-scheduler'));
    assert.strictEqual(res.plan.willSpend, true);
  });

  await test('confirm:true without a token is refused', async () => {
    const { http, calls } = makeFakeHttp();
    await assert.rejects(
      () => runAuthorizedJob(goodJob, { confirm: true, httpRequest: http /* _token absent */ }),
      /DO_API_TOKEN not set/
    );
    assert.strictEqual(calls.length, 0);
  });

  await test('missing authorization is refused before any spend', async () => {
    const { http, calls } = makeFakeHttp();
    const bad = { id: 'x', name: 'no auth' };
    await assert.rejects(
      () => runAuthorizedJob(bad, { confirm: true, _token: 'tkn', httpRequest: http }),
      /authorization invalid/
    );
    assert.strictEqual(calls.length, 0, 'no API call when authorization is invalid');
  });

  await test('unauthorized:false attestation is refused', async () => {
    const { http } = makeFakeHttp();
    const bad = { id: 'x', name: 'n', authorization: { authorized: false, basis: 'own-data', justification: 'xxxxxxxx' } };
    await assert.rejects(() => runAuthorizedJob(bad, { confirm: true, _token: 'tkn', httpRequest: http }), /authorization invalid/);
  });

  await test('confirm:true + token creates a tagged droplet', async () => {
    const { http, calls } = makeFakeHttp();
    const res = await runAuthorizedJob(goodJob, { confirm: true, _token: 'tkn', httpRequest: http, size: 'gpu-h100x1-80gb' });
    assert.strictEqual(res.dryRun, false);
    assert.strictEqual(res.droplet.id, 777);
    const post = calls.find((c) => c.method === 'POST');
    assert.ok(post, 'a POST /v2/droplets happened');
    assert.ok(post.body.tags.includes(MANAGED_TAG), 'droplet is tagged for later teardown');
    assert.ok(post.body.user_data.includes('shutdown -h'), 'self-destruct safety net present in cloud-init');
    assert.strictEqual(post.token, 'tkn');
  });

  await test('token is never taken from the job/options body fields', async () => {
    const { http } = makeFakeHttp();
    // Even if a caller sneaks a token-looking field onto the job, it is ignored.
    const sneaky = { ...goodJob, token: 'SHOULD_BE_IGNORED', DO_API_TOKEN: 'ALSO_IGNORED' };
    await assert.rejects(
      () => runAuthorizedJob(sneaky, { confirm: true, httpRequest: http }),
      /DO_API_TOKEN not set/
    );
  });

  await test('waitActive polls until active (injected sleep)', async () => {
    let getCount = 0;
    const http = async ({ method, url }) => {
      if (method === 'GET' && /\/v2\/droplets\/\d+$/.test(url)) {
        getCount++;
        return { status: 200, json: { droplet: { id: 777, status: getCount >= 3 ? 'active' : 'new' } } };
      }
      return { status: 404, json: {} };
    };
    const p = new DigitalOceanProvisioner({ httpRequest: http, _token: 'tkn' });
    const d = await p.waitActive(777, { pollMs: 1, sleep: () => Promise.resolve() });
    assert.strictEqual(d.status, 'active');
    assert.strictEqual(getCount, 3);
  });

  await test('listManaged / destroyManaged use the managed tag', async () => {
    const { http, calls } = makeFakeHttp();
    const p = new DigitalOceanProvisioner({ httpRequest: http, _token: 'tkn' });
    const list = await p.listManaged();
    assert.strictEqual(list[0].id, 777);
    await p.destroyManaged();
    const del = calls.find((c) => c.method === 'DELETE');
    assert.ok(del.url.includes(`tag_name=${MANAGED_TAG}`));
  });

  await test('API errors surface with status and message', async () => {
    const http = async () => ({ status: 422, json: { message: 'size slug invalid' } });
    const p = new DigitalOceanProvisioner({ httpRequest: http, _token: 'tkn' });
    await assert.rejects(() => p.createDroplet({ name: 'x' }), /422.*size slug invalid/);
  });

  await test('generateRunScript does not embed hashes and does not upload results', () => {
    const s = generateRunScript(goodJob, { maxLifetimeMinutes: 30 });
    assert.ok(s.includes('shutdown -h +30'));
    assert.ok(/does NOT upload results/i.test(s));
    assert.ok(!/hashes\.com/i.test(s), 'no marketplace references in the run script');
  });

  console.log(`\n${passed} checks passed.`);
})();
