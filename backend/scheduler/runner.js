'use strict';

/**
 * Supervised execution runner: the loop that connects "the scheduler chose job
 * X on placement Y" to actually standing up the infrastructure for it.
 *
 * What it automates: the lifecycle — pick the top in-budget, feasible job;
 * provision through the guarded provider adapter (which re-checks authorization,
 * enforces the budget cap, and audits); mark the job running; optionally watch
 * until the instance is gone (self-destruct / spot reclaim / teardown); mark it
 * done; and make sure nothing is left running.
 *
 * What it does NOT do: it does not transfer your hashes or fire hashcat for you.
 * The actual cracking command stays in the reviewed run script the operator
 * completes, so a human stays in the loop on the attack itself. The runner
 * orchestrates machines, not attacks.
 *
 * It inherits every safety property of the provider adapter: dry-run by default,
 * real spend needs confirm + credentials, over-budget jobs are skipped, and the
 * authorization attestation is re-validated at launch.
 */

const { appendAudit, authSnapshot } = require('./audit');

class Runner {
  /**
   * @param {object} cfg
   * @param {object} cfg.scheduler      a Scheduler instance
   * @param {object} cfg.adapter        provider adapter:
   *    { name, run(job, opts)->Promise<result>, refOf(result)->ref,
   *      isActive(ref)->Promise<bool>, teardown(ref)->Promise<any> }
   * @param {object} [cfg.providerOpts] passed to adapter.run (region, size, maxUsd, ...)
   * @param {boolean}[cfg.confirm=false] real provisioning gate
   * @param {object} [cfg.auditOpts]
   */
  constructor(cfg = {}) {
    this.scheduler = cfg.scheduler;
    this.adapter = cfg.adapter;
    this.providerOpts = cfg.providerOpts || {};
    this.confirm = Boolean(cfg.confirm);
    this.auditOpts = cfg.auditOpts || {};
  }

  /** The next job to run: highest-priority planned job that is in budget and feasible. */
  nextEligible(nowMs = Date.now()) {
    const plan = this.scheduler.plan(nowMs);
    for (const row of plan) {
      if (row.overBudget) continue;
      if (!row.chosenPlacement) continue;
      if (row.deadlineFeasible === false) continue; // can't meet deadline; skip (operator decides)
      const job = this.scheduler.getJob(row.jobId);
      if (job && (job.status === 'queued' || job.status === 'planned')) return { job, row };
    }
    return null;
  }

  /**
   * Provision (or plan) the next eligible job.
   * Dry-run unless confirm is set. For a local placement there is nothing to
   * provision — it marks the job running for the operator to execute locally.
   */
  async runNext(nowMs = Date.now()) {
    const pick = this.nextEligible(nowMs);
    if (!pick) return { done: true, message: 'no eligible job (queue empty, all over budget, or infeasible)' };
    const { job, row } = pick;

    // Local placement: no cloud spend; hand off to the operator's local rig.
    if (row.chosenPlacement.location === 'local') {
      if (!this.confirm) return { dryRun: true, job: job.id, placement: row.chosenPlacement, note: 'local placement — run on your own hardware; nothing to provision' };
      this.scheduler.setStatus(job.id, 'running');
      appendAudit({ event: 'run.started', provider: 'local', jobId: job.id, name: job.name, authorization: authSnapshot(job), placement: row.chosenPlacement.id }, this.auditOpts);
      return { dryRun: false, local: true, job: job.id, placement: row.chosenPlacement };
    }

    // Cloud placement: provision through the guarded adapter.
    const opts = {
      ...this.providerOpts,
      confirm: this.confirm,
      estimatedUsd: row.chosenPlacement.usd, // feed the modeled cost to the budget guard
      auditOpts: this.auditOpts,
    };
    const result = await this.adapter.run(job, opts);
    if (result.dryRun) {
      return { dryRun: true, job: job.id, placement: row.chosenPlacement, plan: result.plan };
    }
    this.scheduler.setStatus(job.id, 'running');
    const ref = this.adapter.refOf ? this.adapter.refOf(result) : (result.instance || result.droplet);
    appendAudit({ event: 'run.started', provider: this.adapter.name, jobId: job.id, name: job.name, authorization: authSnapshot(job), ref }, this.auditOpts);
    return { dryRun: false, job: job.id, ref, result };
  }

  /**
   * Watch a running instance until it is no longer active (self-destruct, spot
   * reclaim, or teardown), then mark the job done. Bounded by maxWaitMs.
   */
  async watch(jobId, ref, { intervalMs = 15000, maxWaitMs = 3 * 3600 * 1000, sleep } = {}) {
    if (!this.adapter.isActive) throw new Error('adapter has no isActive(); cannot watch');
    const _sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const deadline = Date.now() + maxWaitMs;
    for (;;) {
      const active = await this.adapter.isActive(ref);
      if (!active) break;
      if (Date.now() > deadline) {
        appendAudit({ event: 'run.watch_timeout', provider: this.adapter.name, jobId, ref }, this.auditOpts);
        return { timedOut: true };
      }
      await _sleep(intervalMs);
    }
    this.scheduler.setStatus(jobId, 'done');
    appendAudit({ event: 'run.finished', provider: this.adapter.name, jobId, ref }, this.auditOpts);
    return { done: true };
  }

  /** Belt-and-braces teardown of an instance, audited. */
  async teardown(jobId, ref) {
    if (!this.adapter.teardown) return { skipped: 'adapter has no teardown()' };
    const r = await this.adapter.teardown(ref);
    appendAudit({ event: 'run.teardown', provider: this.adapter.name, jobId, ref }, this.auditOpts);
    return r;
  }
}

/** Thin adapters wrapping the existing provider runAuthorizedJob + lifecycle. */
function digitalOceanAdapter(provisioner) {
  const do_ = require('./providers/digitalocean');
  const prov = provisioner || new do_.DigitalOceanProvisioner();
  return {
    name: 'digitalocean',
    run: (job, opts) => do_.runAuthorizedJob(job, { ...opts, provisioner: prov }),
    refOf: (res) => res.droplet && res.droplet.id,
    isActive: async (id) => {
      const d = await prov.getDroplet(id).catch(() => null);
      return Boolean(d && d.status !== 'archive' && d.status !== 'off');
    },
    teardown: (id) => prov.destroyDroplet(id),
  };
}

function awsAdapter(provisioner) {
  const aws = require('./providers/aws');
  const prov = provisioner || new aws.AwsProvisioner();
  return {
    name: 'aws',
    run: (job, opts) => aws.runAuthorizedJob(job, { ...opts, provisioner: prov }),
    refOf: (res) => res.instance && res.instance.id,
    isActive: async (id) => {
      const i = await prov.describeInstance(id).catch(() => null);
      const state = i && i.State && i.State.Name;
      return Boolean(state && state !== 'terminated' && state !== 'shutting-down' && state !== 'stopped');
    },
    teardown: (id) => prov.terminateInstance(id),
  };
}

module.exports = { Runner, digitalOceanAdapter, awsAdapter };
