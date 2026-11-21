'use strict';

/**
 * Live pricing helpers so cost decisions use real numbers instead of the static
 * placeholders in providers.json.
 *
 * - AWS spot price: queried from `aws ec2 describe-spot-price-history` (the
 *   current Linux/UNIX price for an instance type in a region/AZ).
 * - DigitalOcean: droplet GPU pricing is effectively fixed per slug, so there's
 *   no live feed; use the value in providers.json (helper included for symmetry).
 *
 * The AWS exec is injectable, so this unit-tests without AWS or network. Callers
 * typically feed the result into the budget guard as `instanceUsdPerHour` (for a
 * worst-case bound) and/or into the cost model.
 */

const { execFile } = require('child_process');

function defaultExec(args, { region } = {}) {
  return new Promise((resolve, reject) => {
    const full = [...args];
    if (region) full.push('--region', region);
    full.push('--output', 'json');
    execFile('aws', full, { maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`aws pricing query failed: ${stderr || err.message}`));
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error('could not parse aws pricing output')); }
    });
  });
}

/**
 * Current AWS spot $/hr for an instance type. Returns the lowest price across
 * returned AZs (cheapest placement) and the full list.
 * @param {string} instanceType e.g. 'g4dn.xlarge'
 * @param {object} [opts] { region, exec, productDescription }
 * @returns {Promise<{ instanceType, cheapestUsdPerHour:number, byAz:object }>}
 */
async function awsSpotPrice(instanceType, opts = {}) {
  const exec = opts.exec || defaultExec;
  const args = [
    'ec2', 'describe-spot-price-history',
    '--instance-types', instanceType,
    '--product-descriptions', opts.productDescription || 'Linux/UNIX',
    '--start-time', new Date().toISOString(),
    '--max-items', '50',
  ];
  const res = await exec(args, { region: opts.region });
  const hist = (res && res.SpotPriceHistory) || [];
  if (hist.length === 0) throw new Error(`no spot price returned for ${instanceType}`);
  // Keep the most recent price per AZ, then take the minimum.
  const byAz = {};
  for (const h of hist) {
    const az = h.AvailabilityZone || 'unknown';
    const price = Number(h.SpotPrice);
    if (!isFinite(price)) continue;
    if (byAz[az] == null || price < byAz[az]) byAz[az] = price;
  }
  const prices = Object.values(byAz);
  const cheapest = prices.length ? Math.min(...prices) : NaN;
  if (!isFinite(cheapest)) throw new Error(`no usable spot price for ${instanceType}`);
  return { instanceType, cheapestUsdPerHour: cheapest, byAz };
}

/** DigitalOcean price for a size slug from providers.json (no live feed). */
function doSizePrice(providers, slug) {
  const match = (providers.cloudInstances || []).find((c) => c.id === slug);
  return match ? match.usdPerHour : null;
}

module.exports = { awsSpotPrice, doSizePrice };
