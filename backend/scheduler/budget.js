'use strict';

/**
 * Budget guard. A cost-aware, money-spending tool should never be able to spend
 * more than the operator allows — not via a fat-fingered keyspace, a wrong
 * hashrate, or a long max-lifetime. These helpers enforce a hard ceiling.
 *
 * Two ceilings:
 *   - maxJobUsd  : the most a single job/launch may cost.
 *   - maxPlanUsd : the most the whole queued plan may cost in aggregate.
 *
 * Enforcement is fail-safe: if a cap is set but no cost figure is available to
 * check against, the action is refused rather than allowed through unchecked.
 */

function round(v, dp = 4) {
  if (!isFinite(v)) return v;
  const f = Math.pow(10, dp);
  return Math.round(v * f) / f;
}

/**
 * Pick the figure to check a launch against: a modeled estimate if we have one,
 * otherwise a guaranteed worst-case upper bound (e.g. hourly price x lifetime).
 */
function effectiveUsd({ estimatedUsd, worstCaseUsd } = {}) {
  if (estimatedUsd != null && isFinite(estimatedUsd)) return estimatedUsd;
  if (worstCaseUsd != null && isFinite(worstCaseUsd)) return worstCaseUsd;
  return null;
}

/**
 * @returns {{ ok:boolean, capped:boolean, figure:number|null, reason?:string }}
 */
function checkJobBudget({ estimatedUsd, worstCaseUsd, maxUsd } = {}) {
  if (maxUsd == null) return { ok: true, capped: false, figure: effectiveUsd({ estimatedUsd, worstCaseUsd }) };
  const figure = effectiveUsd({ estimatedUsd, worstCaseUsd });
  if (figure == null) {
    return {
      ok: false,
      capped: true,
      figure: null,
      reason: `a budget cap of $${maxUsd} is set but no cost estimate is available to check against (provide an estimated or worst-case cost)`,
    };
  }
  if (figure > maxUsd) {
    return {
      ok: false,
      capped: true,
      figure,
      reason: `estimated cost $${round(figure)} exceeds the per-job budget cap of $${maxUsd}`,
    };
  }
  return { ok: true, capped: true, figure };
}

/** Throws a clear error when a launch would breach the per-job cap. */
function assertJobBudget(args) {
  const r = checkJobBudget(args);
  if (!r.ok) throw new Error('Budget cap: ' + r.reason);
  return r;
}

/** Aggregate check for a whole plan. */
function checkPlanBudget({ totalUsd, maxPlanUsd } = {}) {
  if (maxPlanUsd == null) return { ok: true, capped: false, totalUsd };
  if (totalUsd == null || !isFinite(totalUsd)) {
    return { ok: false, capped: true, reason: `plan budget cap $${maxPlanUsd} is set but plan total is unknown` };
  }
  if (totalUsd > maxPlanUsd) {
    return { ok: false, capped: true, totalUsd, reason: `plan total $${round(totalUsd)} exceeds the plan budget cap of $${maxPlanUsd}` };
  }
  return { ok: true, capped: true, totalUsd };
}

module.exports = { checkJobBudget, assertJobBudget, checkPlanBudget, effectiveUsd, round };
