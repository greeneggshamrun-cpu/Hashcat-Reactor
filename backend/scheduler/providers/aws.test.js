'use strict';

/**
 * Mocked tests for the AWS provisioner. No AWS, no network.
 * Run:  node backend/scheduler/providers/aws.test.js
 */

const assert = require('assert');
const { AwsProvisioner, runAuthorizedJob, MANAGED_TAG, DEFAULT_AMI_SSM } = require('./aws');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; throw e; }
}

const goodJob = {
  id: 'job_aws',
  name: 'Recover my own KeePass master',
  authorization: { authorized: true, basis: 'own-data', justification: 'recovering my own KeePass db' },
};

// Fake aws CLI: records calls, returns canned JSON per subcommand.
function makeFakeExec(opts = {}) {
  const calls = [];
  const exec = async (args, ctx) => {
    calls.push({ args, ctx });
    const sub = `${args[0]} ${args[1]}`;
    if (sub === 'sts get-caller-identity') {
      if (opts.noCreds) throw new Error('Unable to locate credentials');
      return { Account: '123456789012', Arn: 'arn:aws:iam::123456789012:user/x' };
    }
    if (sub === 'ssm get-parameters') return { Parameters: [{ Value: 'ami-0deadbeef' }] };
    if (sub === 'ec2 run-instances') return { Instances: [{ InstanceId: 'i-abc123', InstanceType: args[args.indexOf('--instance-type') + 1], State: { Name: 'pending' } }] };
    if (sub === 'ec2 describe-instances') return { Reservations: [{ Instances: [{ InstanceId: 'i-abc123', InstanceType: 'g4dn.xlarge', State: { Name: 'running' } }] }] };
    if (sub === 'ec2 terminate-instances') return { TerminatingInstances: [{ InstanceId: 'i-abc123' }] };
    return {};
  };
  return { exec, calls };
}

(async () => {
  await test('dry run by default: no exec calls, spot is the default cost model', async () => {
    const { exec, calls } = makeFakeExec();
    const res = await runAuthorizedJob(goodJob, { exec });
    assert.strictEqual(res.dryRun, true);
    assert.strictEqual(calls.length, 0, 'dry run must not call aws');
    assert.ok(/spot/i.test(res.plan.costModel), 'defaults to spot');
    assert.strictEqual(res.plan.instanceType, 'g4dn.xlarge');
    assert.ok(res.plan.imageSource.includes(DEFAULT_AMI_SSM));
    assert.ok(res.plan.runScript.includes('reactor-scheduler'));
  });

  await test('missing authorization is refused before any spend', async () => {
    const { exec, calls } = makeFakeExec();
    await assert.rejects(() => runAuthorizedJob({ id: 'x', name: 'n' }, { confirm: true, exec }), /authorization invalid/);
    assert.strictEqual(calls.length, 0);
  });

  await test('confirm:true but no credentials -> refused, no launch', async () => {
    const { exec, calls } = makeFakeExec({ noCreds: true });
    await assert.rejects(() => runAuthorizedJob(goodJob, { confirm: true, exec }), /credentials are not resolvable/);
    // Only the sts probe ran; no run-instances.
    assert.ok(!calls.some((c) => c.args[1] === 'run-instances'), 'nothing launched without creds');
  });

  await test('confirm:true + creds launches a tagged SPOT instance via resolved AMI', async () => {
    const { exec, calls } = makeFakeExec();
    const res = await runAuthorizedJob(goodJob, { confirm: true, exec, region: 'us-east-1' });
    assert.strictEqual(res.dryRun, false);
    assert.strictEqual(res.instance.id, 'i-abc123');
    const run = calls.find((c) => c.args[1] === 'run-instances');
    assert.ok(run, 'run-instances called');
    const a = run.args.join(' ');
    assert.ok(a.includes('--image-id ami-0deadbeef'), 'used SSM-resolved AMI');
    assert.ok(a.includes('MarketType=spot'), 'spot market by default');
    assert.ok(a.includes('instance-initiated-shutdown-behavior terminate'), 'auto-terminate');
    assert.ok(a.includes(`${MANAGED_TAG},Value=true`), 'tagged for teardown');
    assert.strictEqual(run.ctx.region, 'us-east-1');
  });

  await test('spot:false switches to on-demand (no MarketType=spot)', async () => {
    const { exec, calls } = makeFakeExec();
    const res = await runAuthorizedJob(goodJob, { confirm: true, exec, spot: false });
    assert.ok(/on-demand/i.test(res.plan.costModel));
    const run = calls.find((c) => c.args[1] === 'run-instances');
    assert.ok(!run.args.join(' ').includes('MarketType=spot'));
  });

  await test('explicit imageId skips SSM resolution', async () => {
    const { exec, calls } = makeFakeExec();
    await runAuthorizedJob(goodJob, { confirm: true, exec, imageId: 'ami-custom' });
    assert.ok(!calls.some((c) => c.args[1] === 'get-parameters'), 'no SSM lookup when AMI given');
    const run = calls.find((c) => c.args[1] === 'run-instances');
    assert.ok(run.args.join(' ').includes('--image-id ami-custom'));
  });

  await test('listManaged / terminateManaged filter by the managed tag', async () => {
    const { exec, calls } = makeFakeExec();
    const p = new AwsProvisioner({ exec, region: 'us-west-2' });
    const list = await p.listManaged();
    assert.strictEqual(list[0].id, 'i-abc123');
    const desc = calls.find((c) => c.args[1] === 'describe-instances');
    assert.ok(desc.args.join(' ').includes(`tag:${MANAGED_TAG},Values=true`));
    await p.terminateManaged();
    assert.ok(calls.some((c) => c.args[1] === 'terminate-instances'));
  });

  await test('run script marks cudaReady (DLAMI has CUDA) yet keeps the GPU guard', async () => {
    const { exec } = makeFakeExec();
    const res = await runAuthorizedJob(goodJob, { exec });
    assert.ok(/preinstalled driver\+CUDA/.test(res.plan.runScript), 'cudaReady path');
    assert.ok(!/cuda-keyring/.test(res.plan.runScript), 'no driver install on DLAMI');
    assert.ok(/Aborting/.test(res.plan.runScript), 'GPU abort guard remains');
    assert.ok(!/hashes\.com/i.test(res.plan.runScript), 'no marketplace references');
  });

  console.log(`\n${passed} checks passed.`);
})().catch(() => process.exit(1));
