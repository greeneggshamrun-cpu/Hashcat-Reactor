'use strict';

/**
 * Job persistence for the scheduler. The in-memory queue is lost on restart;
 * this persists it to a JSON file so a crash or redeploy doesn't drop queued
 * work. Writes are atomic (temp file + rename) to avoid a half-written file.
 *
 * It stores only job records (never secrets — tokens live in the environment).
 */

const fs = require('fs');
const path = require('path');

function defaultStorePath() {
  if (process.env.SCHEDULER_STORE) return process.env.SCHEDULER_STORE;
  return path.join(__dirname, '..', 'uploads', 'scheduler-jobs.json');
}

/** Load persisted jobs as an array (empty if none/unreadable). */
function loadJobs(opts = {}) {
  const p = opts.storePath || defaultStorePath();
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return Array.isArray(data) ? data : (Array.isArray(data.jobs) ? data.jobs : []);
  } catch (_) {
    return [];
  }
}

/** Persist jobs atomically. Returns {ok, path, error?} and never throws. */
function saveJobs(jobs, opts = {}) {
  const p = opts.storePath || defaultStorePath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(jobs, null, 2));
    fs.renameSync(tmp, p); // atomic on the same filesystem
    return { ok: true, path: p };
  } catch (e) {
    return { ok: false, path: p, error: e.message };
  }
}

module.exports = { loadJobs, saveJobs, defaultStorePath };
