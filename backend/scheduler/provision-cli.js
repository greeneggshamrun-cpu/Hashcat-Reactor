#!/usr/bin/env node
'use strict';

/**
 * CLI for cloud provisioning of an authorized job. This is the ONLY path that
 * can actually spend money, and real actions always require, together:
 *   - working provider credentials (from the environment / provider config), and
 *   - an explicit --confirm flag.
 * Without both it prints the dry-run plan (spec + run script) and stops.
 *
 * Providers: --provider digitalocean (default) | aws
 *   DigitalOcean credential: DO_API_TOKEN in the environment.
 *   AWS credential: the standard AWS chain via the `aws` CLI (env vars, shared
 *                   config, or instance role). Cheapest path = spot (default) +
 *                   a Deep Learning GPU AMI (auto-resolved).
 *
 * Usage:
 *   node provision-cli.js --job job.json [--provider aws] [--confirm] [options]
 *   node provision-cli.js --provider aws --list
 *   node provision-cli.js --provider aws --destroy <id> --confirm
 *   node provision-cli.js --destroy-all --confirm
 *
 * Common options: --region, --max-life <min>, --cuda-ready, --from-source,
 *   --cuda-version NN-N, --image <id/slug>.
 * DigitalOcean: --size <droplet-slug>.
 * AWS: --instance-type <type> (default g4dn.xlarge), --on-demand (disable spot),
 *   --key-name, --subnet-id, --security-group-ids "sg-a sg-b".
 *
 * job.json must contain the job's authorization attestation, e.g.:
 *   { "id":"j1","name":"...","authorization":
 *       {"authorized":true,"basis":"own-data","justification":"my own archive"} }
 */

const fs = require('fs');

function arg(flag, def) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return def;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}
function has(flag) { return process.argv.includes(flag); }

const PROVIDER = (arg('--provider') === true ? null : arg('--provider')) || 'digitalocean';

// Per-provider adapter: how to construct it, its runAuthorizedJob, how to check
// credentials, and the list/destroy verbs. Keeps main() provider-agnostic.
function loadProvider(name) {
  if (name === 'aws') {
    const m = require('./providers/aws');
    const region = arg('--region') === true ? undefined : arg('--region');
    const mk = () => new m.AwsProvisioner({ region });
    return {
      name,
      run: (job, opts) => m.runAuthorizedJob(job, opts),
      credHint: 'configure the aws CLI (env vars, shared config, or an instance role)',
      hasCreds: async () => mk().hasCredentials(),
      list: () => mk().listManaged(),
      destroyOne: (id) => mk().terminateInstance(id),
      destroyAll: () => mk().terminateManaged(),
      extraOpts: () => ({
        region,
        instanceType: arg('--instance-type') === true ? undefined : arg('--instance-type'),
        spot: !has('--on-demand'),
        imageId: arg('--image') === true ? undefined : arg('--image'),
        amiSsmPath: arg('--ami-ssm-path') === true ? undefined : arg('--ami-ssm-path'),
        keyName: arg('--key-name') === true ? undefined : arg('--key-name'),
        subnetId: arg('--subnet-id') === true ? undefined : arg('--subnet-id'),
        securityGroupIds:
          arg('--security-group-ids') && arg('--security-group-ids') !== true
            ? String(arg('--security-group-ids')).split(/[\s,]+/).filter(Boolean)
            : undefined,
      }),
    };
  }
  // default: digitalocean
  const m = require('./providers/digitalocean');
  const mk = () => new m.DigitalOceanProvisioner();
  return {
    name: 'digitalocean',
    run: (job, opts) => m.runAuthorizedJob(job, opts),
    credHint: 'set DO_API_TOKEN in the environment',
    hasCreds: async () => Boolean(process.env.DO_API_TOKEN),
    list: () => mk().listManaged(),
    destroyOne: (id) => mk().destroyDroplet(id),
    destroyAll: () => mk().destroyManaged(),
    extraOpts: () => ({
      region: arg('--region') === true ? undefined : arg('--region'),
      size: arg('--size') === true ? undefined : arg('--size'),
      image: arg('--image') === true ? undefined : arg('--image'),
    }),
  };
}

async function main() {
  const confirm = has('--confirm');
  const prov = loadProvider(PROVIDER);

  if (has('--list')) {
    if (!(await prov.hasCreds())) return bail(`credentials unavailable; ${prov.credHint}`);
    console.log(JSON.stringify(await prov.list(), null, 2));
    return;
  }

  const destroyId = arg('--destroy');
  if (destroyId && destroyId !== true) {
    if (!(await prov.hasCreds())) return bail(`credentials unavailable; ${prov.credHint}`);
    if (!confirm) return bail('Add --confirm to actually destroy ' + destroyId);
    console.log(JSON.stringify(await prov.destroyOne(destroyId)));
    return;
  }

  if (has('--destroy-all')) {
    if (!(await prov.hasCreds())) return bail(`credentials unavailable; ${prov.credHint}`);
    if (!confirm) return bail('Add --confirm to destroy ALL reactor-scheduler instances');
    console.log(JSON.stringify(await prov.destroyAll()));
    return;
  }

  const jobPath = arg('--job');
  if (!jobPath || jobPath === true) return bail('Provide --job <path-to-job.json>');
  const job = JSON.parse(fs.readFileSync(jobPath, 'utf-8'));

  const opts = {
    maxLifetimeMinutes: Number(arg('--max-life')) || undefined,
    cudaReady: has('--cuda-ready') ? true : undefined,
    hashcatFromSource: has('--from-source'),
    cudaVersion: arg('--cuda-version') === true ? undefined : arg('--cuda-version'),
    confirm,
    ...prov.extraOpts(),
  };

  // Fail early with a clear message instead of a provider-internal error.
  if (confirm && !(await prov.hasCreds())) {
    return bail(`--confirm given but credentials unavailable; ${prov.credHint}.`);
  }

  const result = await prov.run(job, opts);

  if (result.dryRun) {
    console.log(`\n=== DRY RUN (${prov.name}: nothing created, no spend) ===`);
    console.log('Plan:', JSON.stringify({ ...result.plan, runScript: undefined }, null, 2));
    console.log('\n--- run script (review before use) ---\n' + result.plan.runScript);
    console.log(`\nTo actually provision: ${prov.credHint} and re-run with --confirm.\n`);
  } else {
    console.log(`\n=== PROVISIONED (${prov.name}) ===`);
    console.log(JSON.stringify(result.instance || result.droplet, null, 2));
    console.log('\n' + result.reminder + '\n');
  }
}

function bail(msg) {
  console.error('error: ' + msg);
  process.exitCode = 1;
}

main().catch((e) => {
  console.error('error: ' + e.message);
  process.exit(1);
});
