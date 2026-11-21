'use strict';

const {
  estimateKeyspace,
  resolvePlacements,
  evaluatePlacements,
} = require('./costModel');
const { checkJobBudget, checkPlanBudget } = require('./budget');
const { appendAudit, authSnapshot } = require('./audit');
const { loadJobs, saveJobs } = require('./store');

/**
 * Cost-aware scheduler for YOUR OWN authorized cracking jobs.
 *
 * What this is:
 *   - A queue of jobs the operator owns or is contractually authorized to run.
 *   - A priority ordering based on deadlines and compute cost-efficiency.
 *   - A placement decision per job: local CPU vs local GPU vs a cloud GPU,
 *     chosen to minimise $ while meeting the job's deadline.
 *
 * What this is deliberately NOT:
 *   - It does not ingest jobs from any marketplace / bounty board.
 *   - It has no concept of a hash's monetary "value" or payout, and therefore
 *     cannot and does not rank work by profitability.
 *   - Every job must carry an explicit authorization attestation or it is
 *     rejected. This keeps the tool pointed at authorized password recovery,
 *     scoped engagements, research, and CTFs.
 */

/** @typedef {'queued'|'planned'|'running'|'done'|'cancelled'|'rejected'} JobStatus */

function validateAuthorization(auth) {
  const errors = [];
  if (!auth || typeof auth !== 'object') {
    return ['authorization block is required (you must attest you are allowed to crack these hashes)'];
  }
  if (auth.authorized !== true) {
    errors.push('authorization.authorized must be exactly true');
  }
  const valid = new Set(['own-data', 'scoped-engagement', 'research', 'ctf']);
  if (!valid.has(auth.basis)) {
    errors.push(`authorization.basis must be one of: ${[...valid].join(', ')}`);
  }
  if (!auth.justification || String(auth.justification).trim().length < 8) {
    errors.push('authorization.justification must be a non-trivial description of why you may run this job');
  }
  if (auth.basis === 'scoped-engagement' && !auth.reference) {
    errors.push('authorization.reference (engagement id / authorization doc) is required for scoped-engagement');
  }
  return errors;
}

let _seq = 0;
function nextId() {
  _seq += 1;
  return `job_${Date.now().toString(36)}_${_seq}`;
}

class Scheduler {
  /**
   * @param {object} providers parsed providers.json
   * @param {object} [opts] { usdPerKwh }
   */
  constructor(providers, opts = {}) {
    this.providers = providers;
    this.usdPerKwh = opts.usdPerKwh != null
      ? opts.usdPerKwh
      : (providers.electricity && providers.electricity.usdPerKwh) || 0.18;
    const budget = providers.budget || {};
    // null in config/opts means "disable that cap"; undefined means "use default".
    this.maxJobUsd = opts.maxJobUsd !== undefined ? opts.maxJobUsd : (budget.maxJobUsd !== undefined ? budget.maxJobUsd : 25);
    this.maxPlanUsd = opts.maxPlanUsd !== undefined ? opts.maxPlanUsd : (budget.maxPlanUsd !== undefined ? budget.maxPlanUsd : 100);
    this.auditOpts = opts.auditOpts || {}; // { logPath } override for tests
    // Optional persistence: opts.persist true (or a storePath) loads any saved
    // jobs now and writes after every mutation. Off by default (tests, ephemeral).
    this.storeOpts = opts.storePath ? { storePath: opts.storePath } : {};
    this.persist = Boolean(opts.persist || opts.storePath);
    /** @type {Map<string, object>} */
    this.jobs = new Map();
    if (this.persist) {
      for (const j of loadJobs(this.storeOpts)) this.jobs.set(j.id, j);
    }
  }

  _save() {
    if (this.persist) saveJobs([...this.jobs.values()], this.storeOpts);
  }

  /**
   * Add a job to the queue.
   * @param {object} spec
   * @param {object} spec.authorization REQUIRED attestation (see validateAuthorization)
   * @param {string} [spec.name]
   * @param {number} [spec.attackMode]
   * @param {number} [spec.keyspace] or fields for estimateKeyspace()
   * @param {Record<string,number>} spec.hashRates placementId -> H/s for this job's hash mode
   * @param {number} [spec.deadlineMs] absolute epoch ms; omit for "no deadline"
   * @param {number} [spec.priorityBoost] operator nudge in [-1,1], default 0
   * @returns {{ ok:boolean, job?:object, errors?:string[] }}
   */
  addJob(spec = {}) {
    const authErrors = validateAuthorization(spec.authorization);
    if (authErrors.length) {
      return { ok: false, errors: authErrors };
    }

    let keyspace;
    try {
      keyspace = spec.keyspace != null ? spec.keyspace : estimateKeyspace(spec);
    } catch (e) {
      return { ok: false, errors: [`keyspace: ${e.message}`] };
    }
    if (!spec.hashRates || typeof spec.hashRates !== 'object') {
      return { ok: false, errors: ['hashRates map (placementId -> H/s) is required'] };
    }

    const job = {
      id: spec.id || nextId(),
      name: spec.name || 'untitled job',
      status: /** @type {JobStatus} */ ('queued'),
      attackMode: spec.attackMode,
      keyspace,
      hashRates: spec.hashRates,
      deadlineMs: spec.deadlineMs != null ? spec.deadlineMs : null,
      priorityBoost: clamp(spec.priorityBoost || 0, -1, 1),
      authorization: {
        authorized: true,
        basis: spec.authorization.basis,
        justification: String(spec.authorization.justification).trim(),
        reference: spec.authorization.reference || null,
      },
      createdAt: Date.now(),
      plan: null,
    };
    this.jobs.set(job.id, job);
    this._save();
    appendAudit({
      event: 'job.added',
      jobId: job.id,
      name: job.name,
      keyspace: job.keyspace,
      authorization: authSnapshot(job),
    }, this.auditOpts);
    return { ok: true, job };
  }

  getJob(id) { return this.jobs.get(id) || null; }

  cancelJob(id) {
    const j = this.jobs.get(id);
    if (!j) return false;
    if (j.status === 'running' || j.status === 'done') return false;
    j.status = 'cancelled';
    this._save();
    return true;
  }

  /** Update a job's status (used by the execution runner) and persist. */
  setStatus(id, status) {
    const j = this.jobs.get(id);
    if (!j) return false;
    j.status = status;
    this._save();
    return true;
  }

  /**
   * Priority score for queue ordering. Higher = run sooner.
   *
   * Factors (all operator-centric, none tied to a hash's "value"):
   *   - Deadline urgency: the closer a deadline relative to the job's own ETA,
   *     the more urgent. Jobs with no deadline get a low, constant urgency.
   *   - Cost efficiency: cheaper-to-finish jobs score a little higher so the
   *     queue clears quick wins without starving anything.
   *   - Operator boost: a manual [-1,1] nudge.
   *
   * @param {object} job
   * @param {number} nowMs
   * @returns {{ score:number, components:object, chosen:object|null }}
   */
  priorityScore(job, nowMs = Date.now()) {
    const placements = resolvePlacements(this.providers, job.hashRates);
    const evalRes = evaluatePlacements(job, placements, {
      usdPerKwh: this.usdPerKwh,
      nowMs,
      deadlineMs: job.deadlineMs,
    });
    const chosen = evalRes.chosen;

    // Urgency: slack = time until deadline minus time needed to finish.
    // Less slack -> more urgent. Normalise with a soft curve into (0,1].
    let urgency;
    if (job.deadlineMs == null || !chosen || !isFinite(chosen.wallClockSeconds)) {
      urgency = 0.15; // background work
    } else {
      const slackSec = (job.deadlineMs - nowMs) / 1000 - chosen.wallClockSeconds;
      // slack <= 0  => urgency ~1 (at/over deadline); large slack => approaches 0.
      urgency = 1 / (1 + Math.max(slackSec, 0) / 3600); // 1hr slack -> 0.5
      if (slackSec < 0) urgency = 1; // already infeasible/late: top urgency
    }

    // Cost efficiency: cheaper chosen placement -> higher. Reference $1.
    let costEff = 0.1;
    if (chosen && isFinite(chosen.usd)) {
      costEff = 1 / (1 + chosen.usd); // $0 -> 1, $1 -> 0.5, $9 -> 0.1
    }

    const score =
      0.7 * urgency +
      0.2 * costEff +
      0.1 * ((job.priorityBoost + 1) / 2); // map [-1,1] -> [0,1]

    return {
      score,
      components: { urgency, costEff, priorityBoost: job.priorityBoost },
      chosen,
      evaluation: evalRes,
    };
  }

  /**
   * Produce an ordered execution plan over all queued jobs.
   * Does not start anything; it only decides order + placement.
   * @param {number} [nowMs]
   * @returns {Array<object>}
   */
  plan(nowMs = Date.now()) {
    const queued = [...this.jobs.values()].filter((j) => j.status === 'queued' || j.status === 'planned');
    const scored = queued.map((job) => {
      const s = this.priorityScore(job, nowMs);
      job.status = 'planned';
      job.plan = {
        score: s.score,
        components: s.components,
        chosen: s.chosen,
        deadlineFeasible: s.evaluation.deadlineFeasible,
        candidates: s.evaluation.candidates,
        plannedAt: nowMs,
      };
      return { job, score: s.score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.map((x, i) => {
      const chosen = x.job.plan.chosen;
      const usd = chosen ? chosen.usd : null;
      const jobBudget = checkJobBudget({ estimatedUsd: usd, maxUsd: this.maxJobUsd });
      x.job.plan.overBudget = !jobBudget.ok;
      return {
        rank: i + 1,
        jobId: x.job.id,
        name: x.job.name,
        score: round(x.score, 4),
        chosenPlacement: chosen
          ? {
              id: chosen.placementId,
              label: chosen.label,
              location: chosen.location,
              etaSeconds: round(chosen.etaSeconds, 1),
              usd: round(chosen.usd, 4),
              meetsDeadline: chosen.meetsDeadline,
            }
          : null,
        deadlineFeasible: x.job.plan.deadlineFeasible,
        // Over-budget jobs are shown but flagged and NOT recommended to run.
        overBudget: !jobBudget.ok,
        budgetNote: jobBudget.ok ? undefined : jobBudget.reason,
        authorization: { basis: x.job.authorization.basis },
      };
    });
  }

  /**
   * Plan plus an aggregate budget verdict. Convenience wrapper over plan() that
   * also reports whether the total breaches maxPlanUsd and which jobs are over
   * the per-job cap.
   */
  planWithBudget(nowMs = Date.now()) {
    const plan = this.plan(nowMs);
    const totalUsd = this.estimatedSpendUsd(nowMs);
    const planBudget = checkPlanBudget({ totalUsd, maxPlanUsd: this.maxPlanUsd });
    return {
      plan,
      estimatedSpendUsd: totalUsd,
      budget: {
        maxJobUsd: this.maxJobUsd,
        maxPlanUsd: this.maxPlanUsd,
        planWithinBudget: planBudget.ok,
        overBudgetJobs: plan.filter((p) => p.overBudget).map((p) => p.jobId),
        note: planBudget.ok ? undefined : planBudget.reason,
      },
    };
  }

  /** Total estimated spend for the current plan's chosen placements. */
  estimatedSpendUsd(nowMs = Date.now()) {
    let total = 0;
    for (const j of this.jobs.values()) {
      if (j.status !== 'queued' && j.status !== 'planned') continue;
      const s = this.priorityScore(j, nowMs);
      if (s.chosen && isFinite(s.chosen.usd)) total += s.chosen.usd;
    }
    return round(total, 4);
  }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function round(v, dp) {
  if (!isFinite(v)) return v;
  const f = Math.pow(10, dp);
  return Math.round(v * f) / f;
}

module.exports = { Scheduler, validateAuthorization };
