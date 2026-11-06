'use strict';

/**
 * Zero-dependency demonstration of the cost-aware scheduler.
 * Run:  node backend/scheduler/demo.js
 *
 * It queues three jobs the operator is authorized to run, then prints the
 * ordered plan with the chosen placement (local CPU vs cloud GPU) and the
 * estimated spend. Hash rates here are illustrative; in the app you feed in
 * measured/benchmarked H/s for your actual hardware and hash mode.
 */

const path = require('path');
const fs = require('fs');
const { Scheduler } = require('./scheduler');

const providers = JSON.parse(fs.readFileSync(path.join(__dirname, 'providers.json'), 'utf-8'));
const s = new Scheduler(providers);
const now = Date.now();
const HOUR = 3600 * 1000;

// Hash rates (H/s) per placement for each job's hash mode. local-gpu is disabled
// in providers.json by default, so only local-cpu + cloud instances are weighed.
const fastRates = { 'local-cpu': 2e7, 'rtx4090-1x': 1.8e11, 'a100-80g-1x': 1.0e11, 'h100-1x': 2.6e11 }; // e.g. NTLM-ish
const slowRates = { 'local-cpu': 3e3, 'rtx4090-1x': 2.0e5, 'a100-80g-1x': 1.3e5, 'h100-1x': 3.0e5 };     // e.g. bcrypt-ish

const jobs = [
  {
    name: 'Recover my own KeePass master (slow hash, no deadline)',
    attackMode: 0, wordlistSize: 1e7, rulesCount: 1,
    hashRates: slowRates,
    authorization: { authorized: true, basis: 'own-data', justification: 'recovering my own KeePass database password' },
  },
  {
    name: 'Scoped pentest: audit dumped AD NTLM hashes (deadline 2h)',
    attackMode: 3, mask: '?u?l?l?l?l?d?d?d', // ~26*26^4*10^3
    hashRates: fastRates,
    deadlineMs: now + 2 * HOUR,
    authorization: { authorized: true, basis: 'scoped-engagement', justification: 'password audit under signed SOW', reference: 'ENG-2025-0442' },
  },
  {
    name: 'CTF challenge hash (fast, tight 20-min deadline)',
    attackMode: 0, wordlistSize: 5e8, rulesCount: 64,
    hashRates: fastRates,
    deadlineMs: now + 20 * 60 * 1000,
    authorization: { authorized: true, basis: 'ctf', justification: 'HTB challenge box, my own instance' },
  },
];

for (const j of jobs) {
  const r = s.addJob(j);
  if (!r.ok) { console.error('rejected:', j.name, r.errors); process.exit(1); }
}

const plan = s.plan(now);

console.log('\nCost-aware plan (your own authorized jobs; ranked by deadline + cost)\n' + '-'.repeat(72));
for (const row of plan) {
  const p = row.chosenPlacement;
  const place = p ? `${p.label || p.id} [${p.location}]` : '(no viable placement)';
  const eta = p ? fmtDuration(p.etaSeconds) : '-';
  const cost = p ? `$${p.usd.toFixed(4)}` : '-';
  const feas = row.deadlineFeasible ? '' : '  ⚠ deadline NOT met (fastest shown)';
  console.log(`#${row.rank}  score=${row.score}  ${row.name}`);
  console.log(`     -> ${place}   eta=${eta}   cost=${cost}   basis=${row.authorization.basis}${feas}`);
}
console.log('-'.repeat(72));
console.log(`Estimated total spend for this plan: $${s.estimatedSpendUsd(now).toFixed(4)}\n`);

function fmtDuration(sec) {
  if (!isFinite(sec)) return '∞';
  if (sec < 90) return `${sec.toFixed(0)}s`;
  if (sec < 5400) return `${(sec / 60).toFixed(1)}m`;
  if (sec < 172800) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86400).toFixed(1)}d`;
}
