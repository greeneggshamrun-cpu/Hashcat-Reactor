#!/usr/bin/env node
'use strict';

/**
 * CLI for DigitalOcean provisioning of an authorized job. This is the ONLY path
 * that can actually spend money, and it requires, together:
 *   - DO_API_TOKEN in the environment (never passed as an argument), and
 *   - an explicit --confirm flag.
 * Without both, it prints the dry-run plan (droplet spec + run script) and stops.
 *
 * Usage:
 *   node provision-cli.js --job job.json [--size gpu-h100x1-80gb] [--region nyc2] \
 *        [--max-life 120] [--confirm]
 *   node provision-cli.js --list                 # list managed droplets
 *   node provision-cli.js --destroy <id>         # destroy one droplet
 *   node provision-cli.js --destroy-all          # sweep all managed droplets (asks to confirm)
 *
 * job.json must contain the job's authorization attestation, e.g.:
 *   { "id":"j1","name":"...","authorization":
 *       {"authorized":true,"basis":"own-data","justification":"my own archive"} }
 */

const fs = require('fs');
const { DigitalOceanProvisioner, runAuthorizedJob } = require('./providers/digitalocean');

function arg(flag, def) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return def;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

async function main() {
  const confirm = process.argv.includes('--confirm');
  const hasToken = Boolean(process.env.DO_API_TOKEN);

  if (process.argv.includes('--list')) {
    requireToken();
    const p = new DigitalOceanProvisioner();
    const list = await p.listManaged();
    console.log(JSON.stringify(list.map((d) => ({ id: d.id, name: d.name, status: d.status })), null, 2));
    return;
  }

  const destroyId = arg('--destroy');
  if (destroyId && destroyId !== true) {
    requireToken();
    if (!confirm) return bail('Add --confirm to actually destroy droplet ' + destroyId);
    const p = new DigitalOceanProvisioner();
    console.log(JSON.stringify(await p.destroyDroplet(destroyId)));
    return;
  }

  if (process.argv.includes('--destroy-all')) {
    requireToken();
    if (!confirm) return bail('Add --confirm to destroy ALL reactor-scheduler droplets');
    const p = new DigitalOceanProvisioner();
    console.log(JSON.stringify(await p.destroyManaged()));
    return;
  }

  const jobPath = arg('--job');
  if (!jobPath || jobPath === true) return bail('Provide --job <path-to-job.json>');
  const job = JSON.parse(fs.readFileSync(jobPath, 'utf-8'));

  const opts = {
    region: arg('--region'),
    size: arg('--size'),
    maxLifetimeMinutes: Number(arg('--max-life')) || undefined,
    confirm,
  };

  if (confirm && !hasToken) {
    return bail('--confirm given but DO_API_TOKEN is not set. Refusing to provision.');
  }

  const result = await runAuthorizedJob(job, opts);

  if (result.dryRun) {
    console.log('\n=== DRY RUN (no droplet created, no spend) ===');
    console.log('Droplet spec:', JSON.stringify(result.plan.dropletSpec, null, 2));
    console.log('\n--- run script (review before use) ---\n' + result.plan.runScript);
    console.log('\nTo actually provision: set DO_API_TOKEN and re-run with --confirm.\n');
  } else {
    console.log('\n=== PROVISIONED ===');
    console.log(JSON.stringify(result.droplet, null, 2));
    console.log('\n' + result.reminder + '\n');
  }
}

function requireToken() {
  if (!process.env.DO_API_TOKEN) {
    bail('DO_API_TOKEN is not set in the environment.');
    process.exit(1);
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
