# Cost-Aware Compute Scheduler

A small, self-contained module that decides **where to run each of your own
authorized cracking jobs** — local CPU, a local GPU, or a rented cloud GPU — to
finish within your deadline for the least money, and in what **order** to run a
queue of them.

It lives entirely under `backend/scheduler/` and is mounted at
`/api/scheduler`. The core (`costModel.js`, `scheduler.js`) has **no
dependencies** and is unit-tested with plain `node`.

## Scope and intent (read this first)

This scheduler is built for work you are **allowed** to do:

- recovering **your own** data (forgotten archive / wallet / KeePass passwords),
- a **scoped engagement** you have signed authorization for (pentest / audit),
- **research**, or a **CTF**.

To keep it pointed there, two design choices are deliberate:

1. **Every job must carry an authorization attestation** (`authorized: true`, a
   `basis`, and a real `justification`; `scoped-engagement` also needs a
   `reference`). Jobs without it are rejected — see `validateAuthorization`.
2. **There is no notion of a hash's monetary value.** The scheduler has no
   marketplace/bounty ingestion and cannot rank work by payout. Ordering is by
   *your* deadlines and *your* compute cost only. It does not read from, submit
   to, or price against hashes.com or any other escrow/bounty service. (The main
   app's separate hashes.com features are untouched by this module and are not
   wired into it.)

If what you need is "pull jobs from a marketplace and rank by profit," this
module intentionally does not do that.

## How placement is decided

For one job:

1. **Keyspace** — candidate count, from the attack mode (dictionary × rules,
   mask expansion, hybrid, combination) or an explicit `--keyspace` value.
2. **ETA per placement** — `keyspace ÷ H/s`, using the measured/benchmarked
   hash rate you provide for each device *for that hash mode*. (The app already
   auto-detects live hashrate; feed that in for accuracy.)
3. **Cost per placement**:
   - **Local** (CPU/GPU): electricity only — `watts × hours × $/kWh`.
   - **Cloud** GPU: `$/hr × billable time` (rounded to the provider's
     granularity/minimum) **plus** a provisioning window that also adds latency.
4. **Choice**: among placements that meet the deadline, pick the **cheapest**
   (tie-break: soonest finish). If none can meet the deadline, fall back to the
   **fastest** and flag `meetsDeadline: false`.

For a queue, each job gets a priority score from **deadline urgency** (how much
slack remains vs. how long it needs), **cost efficiency**, and an optional
manual `priorityBoost` in `[-1, 1]`. Jobs are ordered highest score first.

## Configure your real costs

Edit `providers.json`:

- `electricity.usdPerKwh` — your local marginal rate.
- `localDevices[]` — set `available` and `powerWatts` for your CPU/GPU.
- `cloudInstances[]` — replace `usdPerHour` with your **actual** quotes, and set
  `provisioningSeconds`, `billingGranularitySeconds`, `minBillableSeconds`.

Nothing here provisions cloud instances or spends money — it only *computes the
plan*. Wiring the chosen placement to an actual local run or cloud launcher is a
separate, explicit step you control.

## HTTP API (`/api/scheduler`)

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/providers` | current cost inputs |
| GET | `/jobs` | list queued/planned jobs |
| POST | `/jobs` | add a job (requires `authorization`) |
| DELETE | `/jobs/:id` | cancel a queued job |
| POST | `/plan` | ordered plan + per-job placement + estimated spend |
| GET | `/estimate-spend` | total estimated `$` for the current plan |

### Example: add a job

```bash
curl -X POST localhost:3000/api/scheduler/jobs -H 'content-type: application/json' -d '{
  "name": "Recover my own KeePass master",
  "attackMode": 0,
  "wordlistSize": 10000000,
  "rulesCount": 1,
  "hashRates": { "local-cpu": 3000, "rtx4090-1x": 200000, "a100-80g-1x": 130000, "h100-1x": 300000 },
  "deadlineMs": null,
  "authorization": {
    "authorized": true,
    "basis": "own-data",
    "justification": "recovering my own KeePass database password"
  }
}'
```

`basis` must be one of `own-data`, `scoped-engagement`, `research`, `ctf`.

## Run it

```bash
node backend/scheduler/costModel.test.js   # unit tests (18 checks)
node backend/scheduler/demo.js             # worked example, no deps
```
