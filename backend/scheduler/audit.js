'use strict';

/**
 * Append-only audit log for the scheduler.
 *
 * The tool's whole premise is "authorized jobs only". This log is what makes
 * that attestation accountable: it records who authorized what, and what was
 * actually planned, launched, and torn down — with timestamps — so an operator
 * can later show an engagement stayed in scope.
 *
 * It writes JSON Lines (one JSON object per line) and never records secrets:
 * tokens/keys are never passed into it (and are redacted defensively). Failures
 * to write are swallowed and reported in the return value so auditing can never
 * crash a real run.
 */

const fs = require('fs');
const path = require('path');

const SECRET_KEY = /(token|secret|password|api[-_]?key|authorization)/i;

function defaultLogPath() {
  if (process.env.SCHEDULER_AUDIT_LOG) return process.env.SCHEDULER_AUDIT_LOG;
  // Alongside the app's other state under backend/uploads.
  return path.join(__dirname, '..', 'uploads', 'scheduler-audit.jsonl');
}

/** Shallow-redact any secret-looking keys, just in case a caller over-shares. */
function redact(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_KEY.test(k) && typeof v === 'string') out[k] = '[redacted]';
    else if (v && typeof v === 'object') out[k] = redact(v);
    else out[k] = v;
  }
  return out;
}

/**
 * Append one audit entry.
 * @param {object} entry  arbitrary JSON-able fields (event, jobId, ...)
 * @param {object} [opts] { logPath }
 * @returns {{ ok:boolean, path:string, error?:string }}
 */
function appendAudit(entry, opts = {}) {
  const logPath = opts.logPath || defaultLogPath();
  const record = {
    ts: new Date().toISOString(),
    ...redact(entry || {}),
  };
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify(record) + '\n');
    return { ok: true, path: logPath };
  } catch (e) {
    return { ok: false, path: logPath, error: e.message };
  }
}

/** Read entries back (for a `GET /audit` endpoint or review). */
function readAudit(opts = {}) {
  const logPath = opts.logPath || defaultLogPath();
  let text = '';
  try { text = fs.readFileSync(logPath, 'utf-8'); } catch (_) { return []; }
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch (_) { return null; } })
    .filter(Boolean);
}

/** Build a standard authorization snapshot for an entry (no secrets). */
function authSnapshot(job) {
  const a = (job && job.authorization) || {};
  return { basis: a.basis, justification: a.justification, reference: a.reference || null };
}

module.exports = { appendAudit, readAudit, authSnapshot, defaultLogPath, redact };
