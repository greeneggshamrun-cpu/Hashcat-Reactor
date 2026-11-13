'use strict';

/**
 * Benchmark capture. The cost model needs a real H/s figure per device for the
 * job's hash mode; hand-entered guesses are the biggest source of bad plans.
 * This runs `hashcat -b` and parses the result into H/s, so hashRates can be
 * populated from measurement instead of guesswork.
 *
 * hashcat's --machine-readable benchmark emits lines like:
 *   <deviceId>:<hashMode>:<unused>:<unused>:<speed H/s>
 * e.g.  1:0:...:...:12345678901
 * We sum across devices (hashcat splits work across them) and also keep the
 * per-device breakdown.
 *
 * The exec function is injectable, so this unit-tests without hashcat installed.
 */

const { execFile } = require('child_process');

function defaultExec(args) {
  return new Promise((resolve, reject) => {
    execFile('hashcat', args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      // hashcat may exit non-zero on benchmark completion in some builds; prefer
      // stdout if it parsed, else surface the error.
      if (stdout && stdout.trim()) return resolve(stdout);
      if (err) return reject(new Error(`hashcat -b failed: ${stderr || err.message}`));
      resolve(stdout || '');
    });
  });
}

/**
 * Parse --machine-readable benchmark output for a single hash mode.
 * @param {string} output
 * @returns {{ totalHps:number, perDevice:Record<string,number> }}
 */
function parseMachineReadable(output) {
  const perDevice = {};
  let total = 0;
  for (const line of String(output).split(/[\r\n]+/)) {
    const parts = line.trim().split(':');
    if (parts.length < 5) continue;
    const dev = parts[0];
    const speed = Number(parts[parts.length - 1]); // last field is H/s
    if (!isFinite(speed) || speed <= 0) continue;
    perDevice[dev] = (perDevice[dev] || 0) + speed;
    total += speed;
  }
  return { totalHps: total, perDevice };
}

/**
 * Run a benchmark for one hash mode and return H/s.
 * @param {number|string} hashMode  hashcat -m value
 * @param {object} [opts] { exec, extraArgs }
 * @returns {Promise<{ hashMode, totalHps, perDevice }>}
 */
async function benchmarkMode(hashMode, opts = {}) {
  const exec = opts.exec || defaultExec;
  const args = ['-b', '-m', String(hashMode), '--machine-readable', '--quiet', ...(opts.extraArgs || [])];
  const out = await exec(args);
  const { totalHps, perDevice } = parseMachineReadable(out);
  if (totalHps <= 0) throw new Error(`benchmark produced no usable speed for -m ${hashMode}`);
  return { hashMode: Number(hashMode), totalHps, perDevice };
}

/**
 * Build a hashRates map for the scheduler by assigning the measured total H/s to
 * the given placement ids. A local benchmark measures the local device; use the
 * cloud placements' relative throughput (or benchmark on the instance) for cloud
 * figures. By default every listed placement gets the measured total, which the
 * caller can scale.
 *
 * @param {number} totalHps
 * @param {string[]} placementIds
 * @param {Record<string, number>} [scale] optional per-placement multiplier
 */
function toHashRates(totalHps, placementIds, scale = {}) {
  const map = {};
  for (const id of placementIds) {
    map[id] = totalHps * (scale[id] != null ? scale[id] : 1);
  }
  return map;
}

module.exports = { benchmarkMode, parseMachineReadable, toHashRates };
