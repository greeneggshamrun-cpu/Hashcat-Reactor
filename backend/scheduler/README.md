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

## Authentication

The planning API is unauthenticated by default (fine for localhost). When you
host it, set `SCHEDULER_API_KEY`; every `/api/*` request must then send
`Authorization: Bearer <key>` (or `X-Api-Key: <key>`). `/health` stays open.
Keys are compared in constant time. The service logs a warning at startup if no
key is set.

```bash
SCHEDULER_API_KEY=$(openssl rand -hex 32) node backend/scheduler/server-standalone.js
curl -H "Authorization: Bearer $SCHEDULER_API_KEY" localhost:8080/api/scheduler/providers
```

## DigitalOcean GPU provisioning (optional, guarded)

`providers/digitalocean.js` can launch a GPU droplet to run a job, then tear it
down. This is the only part that spends money, so it is locked down:

- **Dry-run by default.** Nothing launches unless you pass `confirm: true` **and**
  a token is present. A dry run returns the droplet spec + a review-me run
  script and makes no API call.
- **Authorization re-checked at launch.** The job's attestation is validated
  again right before spend; no attestation ⇒ no droplet.
- **Token from the environment only** (`DO_API_TOKEN`) — never from a request
  body or CLI argument, never logged.
- **Spend containment.** Every droplet is tagged `reactor-scheduler`, the
  cloud-init includes a `shutdown` self-destruct after `maxLifetimeMinutes`, and
  `--destroy-all` sweeps leftovers.
- **No result exfiltration.** The run script writes the potfile on the droplet
  for you to `scp` back; nothing is uploaded to any marketplace/escrow/callback.

The HTTP API can only produce the **dry-run plan** (`POST
/jobs/:id/provision-plan`) — it forces `confirm:false` no matter what the client
sends, so the public surface can never launch a droplet. Real provisioning is
CLI-only:

```bash
# dry run (prints droplet spec + run script, no spend):
node backend/scheduler/provision-cli.js --job job.json --size gpu-h100x1-80gb

# actually launch (needs BOTH, together):
export DO_API_TOKEN=***            # your token, in the shell env only
node backend/scheduler/provision-cli.js --job job.json --size gpu-h100x1-80gb --confirm

node backend/scheduler/provision-cli.js --list                  # managed droplets
node backend/scheduler/provision-cli.js --destroy <id> --confirm
node backend/scheduler/provision-cli.js --destroy-all --confirm  # sweep
```

`job.json` must carry the authorization attestation. Set your real GPU `--size`
slug and prices before trusting any plan.

### CUDA-ready cloud-init

The generated run script boots the GPU stack two ways:

- **Fresh Ubuntu 22.04 image (default):** installs the NVIDIA driver + CUDA from
  the official `ubuntu2204` repo (`cuda-keyring` → `cuda-drivers` +
  `cuda-toolkit-<ver>`), then hashcat. A fresh driver install can need one
  reboot before `nvidia-smi` works — if so the GPU guard aborts loudly rather
  than CPU-crack; reboot once and re-run, or use the AI/ML image.
- **DigitalOcean AI/ML image (`--cuda-ready`):** the driver + CUDA are already
  present, so the install is skipped and boot is fast. Confirm the current image
  slug in your account (`doctl compute image list --public | grep -i ml`) and
  pass it with `--image <slug>`.

Flags: `--cuda-ready` (skip install), `--from-source` (build latest hashcat
instead of apt), `--cuda-version 12-4` (toolkit version), `--image <slug>`.
Either way the script verifies hashcat sees a CUDA/OpenCL backend before running
and never uploads results.

```bash
# fresh image, build newest hashcat:
node backend/scheduler/provision-cli.js --job job.json --size <gpu-slug> --from-source
# DO AI/ML image, drivers preinstalled:
node backend/scheduler/provision-cli.js --job job.json --size <gpu-slug> --image <ml-image-slug> --cuda-ready --confirm
```

## Run it

```bash
node backend/scheduler/costModel.test.js             # core unit tests (18)
node backend/scheduler/providers/digitalocean.test.js # provisioner tests (10)
node backend/scheduler/demo.js                       # worked example, no deps
node backend/scheduler/server-standalone.js          # start the planning API
```
