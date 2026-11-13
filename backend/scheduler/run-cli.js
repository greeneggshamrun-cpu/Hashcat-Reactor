#!/usr/bin/env node
'use strict';

/**
 * Execute-loop entrypoint: pick the top in-budget, feasible job from the
 * persisted queue and provision it through the guarded provider.
 *
 * Dry-run by default. Real provisioning needs --confirm AND provider creds, and
 * inherits every guard (authorization re-check, budget cap, audit). Credentials
 * come from the environment only — never pass a token here.
 *
 * Usage:
 *   node run-cli.js [--provider aws|digitalocean] [--confirm] [--watch] [provider opts]
 *
 * The queue is the persisted store (SCHEDULER_STORE or backend/uploads/
 * scheduler-jobs.json); add jobs via the API/library so they persist.
 */

const fs = require('fs');
const path = require('path');
const { Scheduler } = require('./scheduler');
const { Runner, digitalOceanAdapter, awsAdapter } = require('./runner');

function arg(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return undefined;
  const n = process.argv[i + 1];
  return n && !n.startsWith('--') ? n : true;
}
const has = (f) => process.argv.includes(f);

async function main() {
  const providers = JSON.parse(fs.readFileSync(path.join(__dirname, 'providers.json'), 'utf-8'));
  const scheduler = new Scheduler(providers, { persist: true }); // load persisted queue

  const providerName = (arg('--provider') === true ? null : arg('--provider')) || 'digitalocean';
  const adapter = providerName === 'aws' ? awsAdapter() : digitalOceanAdapter();

  const providerOpts = {
    region: arg('--region') === true ? undefined : arg('--region'),
    size: arg('--size') === true ? undefined : arg('--size'),
    instanceType: arg('--instance-type') === true ? undefined : arg('--instance-type'),
    spot: !has('--on-demand'),
    maxUsd: arg('--max-usd') && arg('--max-usd') !== true ? Number(arg('--max-usd')) : (providers.budget && providers.budget.maxJobUsd),
  };

  const runner = new Runner({ scheduler, adapter, providerOpts, confirm: has('--confirm') });
  const out = await runner.runNext();

  if (out.done) { console.log('Nothing to run:', out.message); return; }
  if (out.dryRun) {
    console.log(`\n=== DRY RUN (${providerName}: nothing provisioned) ===`);
    console.log(JSON.stringify({ job: out.job, placement: out.placement }, null, 2));
    console.log('\nRe-run with --confirm and provider credentials to launch.\n');
    return;
  }
  console.log(`\n=== RUNNING (${providerName}) ===`);
  console.log(JSON.stringify({ job: out.job, ref: out.ref }, null, 2));

  if (has('--watch') && out.ref) {
    console.log('watching until the instance terminates (self-destruct / spot reclaim)...');
    const w = await runner.watch(out.job, out.ref, {});
    console.log('watch result:', JSON.stringify(w));
  } else {
    console.log('Instance auto-terminates on shutdown; use --watch to track, or the provider --list/--destroy-all to sweep.');
  }
}

main().catch((e) => { console.error('error: ' + e.message); process.exit(1); });
