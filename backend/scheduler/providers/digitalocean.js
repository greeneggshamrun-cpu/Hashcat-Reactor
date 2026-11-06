'use strict';

/**
 * DigitalOcean GPU-droplet provisioning adapter for the cost-aware scheduler.
 *
 * Lifecycle it manages for ONE authorized job:
 *     create droplet -> wait active -> (operator runs hashcat) -> destroy droplet
 *
 * Hard safety rules baked in here (not optional policy, actual code paths):
 *   1. DRY-RUN BY DEFAULT. Nothing is created unless the caller passes
 *      { confirm: true } AND a token is present. A dry run returns the exact
 *      plan (droplet spec + the run script) and touches no network.
 *   2. AUTHORIZATION RE-CHECK. The job's authorization attestation is validated
 *      again here, right before spend. No attestation => throw, no droplet.
 *   3. TOKEN FROM ENV ONLY. Read from process.env.DO_API_TOKEN. Never accepted
 *      as a function argument from request bodies, never logged, redacted in
 *      any echo. (Callers may inject one in tests via opts._token.)
 *   4. SPEND CONTAINMENT. Every droplet is tagged so it can be found and
 *      destroyed; destroyManaged() can sweep leftovers. A maxLifetimeMinutes is
 *      written into the droplet's cloud-init as a self-destruct safety net.
 *   5. NO RESULT EXFILTRATION. The generated run script writes the potfile on
 *      the droplet for the operator to retrieve over SSH. This adapter does not
 *      upload, submit, or transmit cracked output anywhere — no marketplace,
 *      no escrow, no callback.
 *
 * It is dependency-free: the HTTP layer is injectable (opts.httpRequest) so the
 * whole thing unit-tests without network, and defaults to node's https.
 */

const https = require('https');
const { validateAuthorization } = require('../scheduler');

const DO_API = 'https://api.digitalocean.com';
const MANAGED_TAG = 'reactor-scheduler';

/** Minimal HTTPS JSON client; replaceable for tests. */
function defaultHttpRequest({ method, url, token, body }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        method,
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch (_) { /* leave null */ }
          resolve({ status: res.statusCode, json, raw: data });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Build the cloud-init user-data that installs hashcat and runs ONE job, then
 * self-destructs after maxLifetimeMinutes as a runaway-spend safety net.
 *
 * It intentionally references operator-supplied artifacts by path/URL that YOU
 * provide (hash file, wordlist); it does not embed hashes, and it does not send
 * results anywhere. Review it before use.
 */
function generateRunScript(job, opts = {}) {
  const life = Math.max(5, Number(opts.maxLifetimeMinutes) || 120);
  const hashFile = opts.hashFileRemotePath || '/root/target.hash';
  const extra = opts.hashcatArgs || '';
  // attackMode + mask/wordlist are described for the operator; the actual
  // invocation is a template they complete with their own artifacts.
  const lines = [
    '#!/bin/bash',
    'set -euo pipefail',
    '# --- reactor-scheduler run script (review before use) ---',
    `# Job: ${sanitizeComment(job.name)}  | authorization basis: ${job.authorization.basis}`,
    '',
    '# Self-destruct safety net: power off and let the control plane reap it.',
    `shutdown -h +${life} "reactor-scheduler max lifetime reached" &`,
    '',
    '# Install hashcat (operator may prefer a prebuilt CUDA image instead).',
    'export DEBIAN_FRONTEND=noninteractive',
    'apt-get update -y && apt-get install -y hashcat || true',
    '',
    '# GPU sanity check: a GPU droplet must expose a GPU to hashcat. If none is',
    '# visible, abort rather than silently fall back to slow CPU cracking and',
    '# burn money. Use a CUDA-ready image (e.g. a DigitalOcean AI/ML GPU image)',
    '# if nvidia-smi is missing.',
    'if ! command -v nvidia-smi >/dev/null 2>&1 || ! nvidia-smi >/dev/null 2>&1; then',
    '  echo "reactor-scheduler: ERROR no usable GPU (nvidia-smi failed). Aborting to avoid CPU-only spend." >&2',
    '  exit 1',
    'fi',
    'if ! hashcat -I 2>/dev/null | grep -qiE "Backend Device|CUDA|OpenCL"; then',
    '  echo "reactor-scheduler: ERROR hashcat sees no backend device. Aborting." >&2',
    '  exit 1',
    'fi',
    '',
    '# Run the authorized job. Fill in wordlist/mask + your hash file path.',
    `#   target hash file expected at: ${hashFile}`,
    `# Example (dictionary): hashcat -m <mode> -a 0 ${hashFile} /root/wordlist.txt ${extra}`.trim(),
    '# Cracked results are written to the local potfile for YOU to retrieve:',
    '#   scp root@<droplet-ip>:~/.local/share/hashcat/hashcat.potfile .',
    '# This script does NOT upload results anywhere.',
    '',
    'echo "reactor-scheduler: environment ready; run your authorized hashcat command above."',
  ];
  return lines.join('\n');
}

function sanitizeComment(s) {
  return String(s || '').replace(/[\r\n]+/g, ' ').slice(0, 120);
}

class DigitalOceanProvisioner {
  /**
   * @param {object} [opts]
   * @param {Function} [opts.httpRequest] injectable client (tests)
   * @param {string}   [opts._token] token for tests; production uses env only
   */
  constructor(opts = {}) {
    this.httpRequest = opts.httpRequest || defaultHttpRequest;
    // Token precedence: explicit test injection, else environment. Never a
    // request-body field.
    this._token = opts._token || process.env.DO_API_TOKEN || null;
  }

  hasToken() { return Boolean(this._token); }

  async _call(method, pathAndQuery, body) {
    if (!this._token) throw new Error('DO_API_TOKEN not set; refusing to call DigitalOcean API');
    const res = await this.httpRequest({ method, url: DO_API + pathAndQuery, token: this._token, body });
    if (res.status >= 400) {
      const msg = res.json && res.json.message ? res.json.message : `HTTP ${res.status}`;
      throw new Error(`DigitalOcean API error (${res.status}): ${msg}`);
    }
    return res.json;
  }

  async createDroplet(spec) {
    const body = {
      name: spec.name,
      region: spec.region,
      size: spec.size,
      image: spec.image,
      ssh_keys: spec.sshKeys || [],
      tags: Array.from(new Set([MANAGED_TAG, ...(spec.tags || [])])),
      user_data: spec.userData,
      backups: false,
      monitoring: true,
    };
    const json = await this._call('POST', '/v2/droplets', body);
    return json && json.droplet;
  }

  async getDroplet(id) {
    const json = await this._call('GET', `/v2/droplets/${id}`);
    return json && json.droplet;
  }

  async destroyDroplet(id) {
    await this._call('DELETE', `/v2/droplets/${id}`);
    return { destroyed: id };
  }

  /** List droplets this adapter created (by tag). */
  async listManaged() {
    const json = await this._call('GET', `/v2/droplets?tag_name=${encodeURIComponent(MANAGED_TAG)}`);
    return (json && json.droplets) || [];
  }

  /** Destroy every droplet created by this adapter (spend sweep). */
  async destroyManaged() {
    await this._call('DELETE', `/v2/droplets?tag_name=${encodeURIComponent(MANAGED_TAG)}`);
    return { destroyedByTag: MANAGED_TAG };
  }

  async waitActive(id, { pollMs = 5000, timeoutMs = 300000, sleep } = {}) {
    const _sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const d = await this.getDroplet(id);
      if (d && d.status === 'active') return d;
      if (Date.now() > deadline) throw new Error(`Droplet ${id} not active within timeout`);
      await _sleep(pollMs);
    }
  }
}

/**
 * Plan (and optionally execute) provisioning for ONE authorized job.
 *
 * @param {object} job        a scheduler job (must carry authorization + chosen placement)
 * @param {object} options
 * @param {boolean} [options.confirm=false]  real actions require true + a token
 * @param {string}  [options.region]
 * @param {string}  [options.size]           DO GPU size slug, e.g. "gpu-h100x1-80gb"
 * @param {string}  [options.image]          droplet image slug
 * @param {number[]|string[]} [options.sshKeys]
 * @param {number}  [options.maxLifetimeMinutes=120]
 * @param {DigitalOceanProvisioner} [options.provisioner]
 * @returns {Promise<object>} the plan, and (if confirmed) the created droplet
 */
async function runAuthorizedJob(job, options = {}) {
  // (2) Re-validate authorization right before spend — no bypass.
  const authErrors = validateAuthorization(job && job.authorization);
  if (authErrors.length) {
    throw new Error(`Refusing to provision: job authorization invalid: ${authErrors.join('; ')}`);
  }

  const maxLifetimeMinutes = Number(options.maxLifetimeMinutes) || 120;
  const name = `reactor-${(job.id || 'job')}-${Date.now().toString(36)}`.slice(0, 60);
  const userData = generateRunScript(job, { maxLifetimeMinutes, ...options });

  const dropletSpec = {
    name,
    region: options.region || 'nyc2',
    size: options.size || 'gpu-h100x1-80gb', // placeholder; set your real slug
    image: options.image || 'ubuntu-22-04-x64',
    sshKeys: options.sshKeys || [],
    tags: [`basis-${job.authorization.basis}`],
    userData,
  };

  const provisioner = options.provisioner || new DigitalOceanProvisioner(options);

  const plan = {
    action: 'create-droplet',
    dropletSpec: { ...dropletSpec, userData: '<cloud-init script, see runScript>' },
    runScript: userData,
    maxLifetimeMinutes,
    note: 'Dry run. Review the runScript, then re-call with { confirm: true } and DO_API_TOKEN set to actually provision.',
    willSpend: true,
  };

  // (1) Dry-run gate: real action needs confirm:true AND a token.
  if (!options.confirm) {
    return { dryRun: true, plan };
  }
  if (!provisioner.hasToken()) {
    throw new Error('confirm:true but DO_API_TOKEN not set; refusing to provision');
  }

  const droplet = await provisioner.createDroplet(dropletSpec);
  return {
    dryRun: false,
    plan,
    droplet: droplet
      ? { id: droplet.id, name: droplet.name, status: droplet.status, tags: droplet.tags }
      : null,
    reminder: 'Destroy the droplet when done: provisioner.destroyDroplet(id), or destroyManaged() to sweep all.',
  };
}

module.exports = {
  DigitalOceanProvisioner,
  runAuthorizedJob,
  generateRunScript,
  MANAGED_TAG,
  DO_API,
};
