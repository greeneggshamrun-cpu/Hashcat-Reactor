'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { Scheduler } = require('./scheduler');

/**
 * Mountable Express router exposing the cost-aware scheduler.
 *
 * Mount in server.js with:
 *     const createSchedulerRouter = require('./scheduler/router');
 *     app.use('/api/scheduler', createSchedulerRouter());
 *
 * Endpoints (all operate on YOUR OWN authorized jobs; no marketplace I/O):
 *   GET    /providers            current cost inputs (local devices + cloud quotes)
 *   GET    /jobs                 list queued/planned jobs
 *   POST   /jobs                 add a job (requires authorization attestation)
 *   DELETE /jobs/:id             cancel a queued job
 *   POST   /plan                 compute ordered plan + placement decisions
 *   GET    /estimate-spend       total estimated $ for the current plan
 */
module.exports = function createSchedulerRouter(opts = {}) {
  const router = express.Router();

  const providersPath = opts.providersPath || path.join(__dirname, 'providers.json');
  let providers;
  try {
    providers = JSON.parse(fs.readFileSync(providersPath, 'utf-8'));
  } catch (e) {
    throw new Error(`Scheduler: failed to read providers config at ${providersPath}: ${e.message}`);
  }

  const scheduler = new Scheduler(providers, opts);

  router.get('/providers', (_req, res) => {
    res.json({
      electricity: providers.electricity,
      localDevices: providers.localDevices,
      cloudInstances: providers.cloudInstances,
    });
  });

  router.get('/jobs', (_req, res) => {
    res.json([...scheduler.jobs.values()]);
  });

  router.post('/jobs', (req, res) => {
    const result = scheduler.addJob(req.body || {});
    if (!result.ok) {
      return res.status(400).json({ message: 'Job rejected', errors: result.errors });
    }
    res.status(201).json(result.job);
  });

  router.delete('/jobs/:id', (req, res) => {
    const ok = scheduler.cancelJob(req.params.id);
    if (!ok) return res.status(409).json({ message: 'Job not found or not cancellable' });
    res.json({ success: true });
  });

  router.post('/plan', (_req, res) => {
    try {
      const plan = scheduler.plan();
      res.json({ plan, estimatedSpendUsd: scheduler.estimatedSpendUsd() });
    } catch (e) {
      res.status(500).json({ message: 'Planning failed', error: e.message });
    }
  });

  router.get('/estimate-spend', (_req, res) => {
    res.json({ estimatedSpendUsd: scheduler.estimatedSpendUsd() });
  });

  // Dry-run-ONLY provisioning plan for a queued job. This endpoint never spends
  // money and never calls DigitalOcean: it returns the droplet spec + the
  // review-me run script. Actually launching a droplet is deliberately kept out
  // of the HTTP surface — use the CLI (provision-cli.js) with DO_API_TOKEN set
  // and an explicit --confirm, so spend always requires a shell + a human.
  router.post('/jobs/:id/provision-plan', async (req, res) => {
    const job = scheduler.getJob(req.params.id);
    if (!job) return res.status(404).json({ message: 'Job not found' });
    try {
      const { runAuthorizedJob } = require('./providers/digitalocean');
      const planOpts = {
        region: req.body && req.body.region,
        size: req.body && req.body.size,
        maxLifetimeMinutes: req.body && req.body.maxLifetimeMinutes,
        // confirm is forced false here regardless of what the client sends.
        confirm: false,
      };
      const result = await runAuthorizedJob(job, planOpts);
      res.json(result);
    } catch (e) {
      res.status(400).json({ message: 'Cannot plan provisioning', error: e.message });
    }
  });

  // Expose the instance for tests / programmatic use.
  router._scheduler = scheduler;
  return router;
};
