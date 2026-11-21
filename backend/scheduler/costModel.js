'use strict';

/**
 * Cost model for the cost-aware compute scheduler.
 *
 * Scope: this module answers one question for a SINGLE job you are authorized
 * to run — "given the keyspace and how fast each device chews through it,
 * which placement (local CPU, local GPU, or a cloud GPU instance) gets it done
 * for the least money while still meeting the deadline?"
 *
 * It does not know or care about hash *value*. There is no notion of a payout,
 * a bounty, or a marketplace here. Ranking across jobs (see scheduler.js) is by
 * your own deadlines and compute cost, never by what a hash is "worth".
 *
 * All functions are pure and dependency-free so they can be unit-tested with
 * plain `node`.
 */

/** Attack modes mirror hashcat's -a values plus a direct keyspace escape hatch. */
const ATTACK_MODES = {
  DICTIONARY: 0, // wordlist (optionally x rules)
  COMBINATION: 1,
  MASK: 3, // brute-force / mask
  HYBRID_WM: 6,
  HYBRID_MW: 7,
};

// Default charset cardinalities for the common hashcat ?-placeholders. Callers
// can pass explicit per-position sizes instead when they use custom charsets.
const CHARSET_SIZES = {
  l: 26, // abcdefghijklmnopqrstuvwxyz
  u: 26, // ABCDEFGHIJKLMNOPQRSTUVWXYZ
  d: 10, // 0123456789
  h: 16, // 0123456789abcdef
  H: 16, // 0123456789ABCDEF
  s: 33, // special characters
  a: 95, // ?l?u?d?s
  b: 256, // 0x00 - 0xff
};

/**
 * Expand a mask like "?u?l?l?l?d?d" into the number of candidates it covers.
 * Literal characters (not preceded by ?) each contribute a factor of 1.
 * @param {string} mask
 * @param {Record<string, number>} [customCharsets] optional overrides, e.g. {1: 62}
 * @returns {number}
 */
function maskKeyspace(mask, customCharsets = {}) {
  if (!mask) return 0;
  let product = 1;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === '?' && i + 1 < mask.length) {
      const token = mask[i + 1];
      const size = customCharsets[token] != null ? customCharsets[token] : CHARSET_SIZES[token];
      if (size == null) throw new Error(`Unknown mask charset token: ?${token}`);
      product *= size;
      i++; // consume token
    } else {
      product *= 1; // literal position
    }
  }
  return product;
}

/**
 * Estimate the number of password candidates a job will test.
 *
 * @param {object} job
 * @param {number} [job.attackMode]
 * @param {number} [job.explicitKeyspace]  if set, used verbatim (e.g. from `hashcat --keyspace`)
 * @param {number} [job.wordlistSize]      number of words in the wordlist
 * @param {number} [job.rulesCount]        number of rules (multiplies the wordlist); default 1
 * @param {string} [job.mask]              mask string, for MASK / hybrid modes
 * @param {Record<string,number>} [job.customCharsets]
 * @param {number} [job.combinatorSize]    words in the 2nd list for COMBINATION
 * @returns {number} keyspace (candidate count)
 */
function estimateKeyspace(job = {}) {
  if (job.explicitKeyspace != null) {
    if (job.explicitKeyspace < 0) throw new Error('explicitKeyspace must be >= 0');
    return job.explicitKeyspace;
  }
  const mode = job.attackMode != null ? job.attackMode : ATTACK_MODES.DICTIONARY;
  const rules = job.rulesCount && job.rulesCount > 0 ? job.rulesCount : 1;

  switch (mode) {
    case ATTACK_MODES.DICTIONARY:
      return (job.wordlistSize || 0) * rules;
    case ATTACK_MODES.COMBINATION:
      return (job.wordlistSize || 0) * (job.combinatorSize || 0);
    case ATTACK_MODES.MASK:
      return maskKeyspace(job.mask, job.customCharsets);
    case ATTACK_MODES.HYBRID_WM:
    case ATTACK_MODES.HYBRID_MW:
      return (job.wordlistSize || 0) * maskKeyspace(job.mask, job.customCharsets);
    default:
      throw new Error(`Unsupported attackMode: ${mode}`);
  }
}

/**
 * Estimate wall-clock seconds to exhaust `keyspace` at `hashRate` H/s.
 * hashRate should be the measured/benchmarked rate for the device + hash mode;
 * the app already auto-detects live hashrate, so prefer feeding that in.
 *
 * @param {number} keyspace
 * @param {number} hashRate  candidates per second (> 0)
 * @returns {number} seconds (Infinity if hashRate <= 0)
 */
function estimateEtaSeconds(keyspace, hashRate) {
  if (!keyspace || keyspace <= 0) return 0;
  if (!hashRate || hashRate <= 0) return Infinity;
  return keyspace / hashRate;
}

/** Round billed seconds up to the provider's granularity and minimum. */
function billableSeconds(etaSeconds, placement) {
  const gran = placement.billingGranularitySeconds || 1;
  const min = placement.minBillableSeconds || 0;
  const rounded = Math.ceil(etaSeconds / gran) * gran;
  return Math.max(rounded, min);
}

/**
 * Price a single placement for a job whose runtime is `etaSeconds` on that
 * placement's hardware.
 *
 * Local devices cost only electricity (watts over the runtime). Cloud devices
 * cost the hourly rate over billable time, plus a one-off provisioning window
 * that also counts as wall-clock latency before cracking starts.
 *
 * @param {object} placement  a resolved placement (see resolvePlacements)
 * @param {number} etaSeconds compute time on this placement
 * @param {object} ctx        { usdPerKwh }
 * @returns {{ usd:number, wallClockSeconds:number, computeSeconds:number, breakdown:object }}
 */
function placementCost(placement, etaSeconds, ctx = {}) {
  const usdPerKwh = ctx.usdPerKwh != null ? ctx.usdPerKwh : 0.18;

  if (etaSeconds === Infinity) {
    return {
      usd: Infinity,
      wallClockSeconds: Infinity,
      computeSeconds: Infinity,
      breakdown: { reason: 'hashRate unknown or zero for this placement' },
    };
  }

  if (placement.location === 'local') {
    const hours = etaSeconds / 3600;
    const kwh = (placement.powerWatts || 0) / 1000 * hours;
    const usd = kwh * usdPerKwh;
    return {
      usd,
      wallClockSeconds: etaSeconds,
      computeSeconds: etaSeconds,
      breakdown: { electricityUsd: usd, kwh, powerWatts: placement.powerWatts || 0 },
    };
  }

  // cloud
  const billSec = billableSeconds(etaSeconds, placement);
  const computeUsd = (placement.usdPerHour || 0) * (billSec / 3600);
  const provSec = placement.provisioningSeconds || 0;
  // Provisioning is usually billed too once the instance is up.
  const provUsd = (placement.usdPerHour || 0) * (provSec / 3600);
  const usd = computeUsd + provUsd;
  return {
    usd,
    wallClockSeconds: etaSeconds + provSec,
    computeSeconds: etaSeconds,
    breakdown: {
      computeUsd,
      provisioningUsd: provUsd,
      billableSeconds: billSec,
      provisioningSeconds: provSec,
      usdPerHour: placement.usdPerHour || 0,
    },
  };
}

/**
 * Resolve the raw providers config + a per-job hashrate map into concrete
 * placement candidates.
 *
 * hashRates maps placementId -> measured/estimated H/s for THIS job's hash mode.
 * A placement with no known hashrate is still returned but priced as Infinity,
 * so the caller can see it was considered and why it was skipped.
 *
 * @param {object} providers  parsed providers.json
 * @param {Record<string, number>} hashRates
 * @returns {Array<object>} normalized placements
 */
function resolvePlacements(providers, hashRates = {}) {
  const out = [];
  for (const d of providers.localDevices || []) {
    if (d.available === false) continue;
    out.push({
      id: d.id,
      label: d.label || d.id,
      kind: d.kind,
      location: 'local',
      powerWatts: d.powerWatts || 0,
      hashRate: hashRates[d.id],
    });
  }
  for (const c of providers.cloudInstances || []) {
    if (c.available === false) continue;
    out.push({
      id: c.id,
      label: c.label || c.id,
      kind: c.kind || 'gpu',
      location: 'cloud',
      usdPerHour: c.usdPerHour || 0,
      billingGranularitySeconds: c.billingGranularitySeconds || 1,
      minBillableSeconds: c.minBillableSeconds || 0,
      provisioningSeconds: c.provisioningSeconds || 0,
      hashRate: hashRates[c.id],
    });
  }
  return out;
}

/**
 * Evaluate every placement for one job and return them sorted best-first.
 *
 * Selection policy:
 *   1. Compute ETA + cost for each placement.
 *   2. Partition into those that MEET the deadline (if a deadline is given) and
 *      those that do not.
 *   3. Prefer feasible placements, cheapest first (tie-break: sooner finish).
 *   4. If nothing meets the deadline, fall back to the FASTEST placement so the
 *      operator at least gets the best possible outcome, and flag it.
 *
 * @param {object} job     must carry keyspace (or fields for estimateKeyspace)
 * @param {Array}  placements  from resolvePlacements
 * @param {object} ctx     { usdPerKwh, nowMs, deadlineMs }
 * @returns {{ candidates: Array, chosen: object|null, deadlineFeasible: boolean }}
 */
function evaluatePlacements(job, placements, ctx = {}) {
  const usdPerKwh = ctx.usdPerKwh;
  const keyspace = job.keyspace != null ? job.keyspace : estimateKeyspace(job);
  const nowMs = ctx.nowMs != null ? ctx.nowMs : Date.now();
  const deadlineMs = ctx.deadlineMs != null ? ctx.deadlineMs : (job.deadlineMs != null ? job.deadlineMs : null);
  const budgetSeconds = deadlineMs != null ? (deadlineMs - nowMs) / 1000 : null;

  const candidates = placements.map((p) => {
    const eta = estimateEtaSeconds(keyspace, p.hashRate);
    const cost = placementCost(p, eta, { usdPerKwh });
    const meetsDeadline = budgetSeconds == null ? true : cost.wallClockSeconds <= budgetSeconds;
    return {
      placementId: p.id,
      label: p.label,
      location: p.location,
      kind: p.kind,
      hashRate: p.hashRate || null,
      keyspace,
      etaSeconds: eta,
      usd: cost.usd,
      wallClockSeconds: cost.wallClockSeconds,
      meetsDeadline,
      breakdown: cost.breakdown,
    };
  });

  const feasible = candidates.filter((c) => c.meetsDeadline && isFinite(c.usd));
  const byCost = (a, b) => (a.usd - b.usd) || (a.wallClockSeconds - b.wallClockSeconds);
  const bySpeed = (a, b) => (a.wallClockSeconds - b.wallClockSeconds) || (a.usd - b.usd);

  let chosen = null;
  let deadlineFeasible = true;
  if (feasible.length > 0) {
    feasible.sort(byCost);
    chosen = feasible[0];
  } else {
    deadlineFeasible = budgetSeconds == null; // if there was no deadline, "feasible" was everyone
    const finite = candidates.filter((c) => isFinite(c.wallClockSeconds));
    finite.sort(bySpeed);
    chosen = finite[0] || null;
  }

  // Stable, readable ordering for display: chosen-eligible set first by cost.
  candidates.sort(byCost);

  return { keyspace, candidates, chosen, deadlineFeasible };
}

module.exports = {
  ATTACK_MODES,
  CHARSET_SIZES,
  maskKeyspace,
  estimateKeyspace,
  estimateEtaSeconds,
  billableSeconds,
  placementCost,
  resolvePlacements,
  evaluatePlacements,
};
