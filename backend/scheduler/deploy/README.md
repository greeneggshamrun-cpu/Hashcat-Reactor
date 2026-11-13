# Deploying the scheduler to DigitalOcean

This deploys the **planning service only** — the API that decides local-CPU vs
cloud-GPU placement and job order for your own authorized jobs. It does **not**
run hashcat and does **not** provision GPU instances; it returns plans you act
on yourself. There is no marketplace/escrow traffic.

You deploy it to **your own** DigitalOcean account. These steps need your DO
login/token, which stays with you — don't paste tokens into chat tools.

## Option A0 — Container Registry (DOCR) + App Platform

Export the service as a container image into your own DigitalOcean Container
Registry, then run it on App Platform from that image. Run the script on your
machine (needs a running Docker daemon and an authenticated `doctl`):

```bash
doctl registry create my-registry          # once, if you don't have one
backend/scheduler/deploy/build-and-push.sh my-registry v1
# -> builds + pushes registry.digitalocean.com/my-registry/reactor-scheduler:v1

# edit deploy/do-app-image.yaml (repository/tag), then:
doctl apps create --spec backend/scheduler/deploy/do-app-image.yaml
```

No secrets go into the image — set `SCHEDULER_API_KEY` as an **encrypted**
app-level secret before exposing the app (App Platform apps are public).

## Option A — App Platform (managed, simplest)

1. Install and authenticate the CLI:
   ```bash
   # macOS: brew install doctl   |   Linux: snap install doctl
   doctl auth init          # paste your DO API token when prompted
   ```
2. Edit `do-app.yaml`: set `github.repo`/`branch` to your fork and default
   branch (App Platform builds from a branch, not this feature branch).
3. Create the app:
   ```bash
   doctl apps create --spec backend/scheduler/deploy/do-app.yaml
   ```
4. Get the URL and test it:
   ```bash
   doctl apps list
   curl https://<your-app>.ondigitalocean.app/health
   ```

App Platform apps are **public by default**. Put auth / a reverse proxy in
front, or restrict it, before exposing it — the API has no built-in auth.

## Option B — Docker on a droplet

```bash
# on the droplet, with the repo checked out:
cd backend/scheduler
docker build -t reactor-scheduler .
docker run -d --restart unless-stopped -p 8080:8080 \
  -e SCHED_USD_PER_KWH=0.18 --name scheduler reactor-scheduler
curl http://localhost:8080/health
```

Bind it to localhost + an SSH tunnel, or a firewalled port, rather than
exposing 8080 to the world.

## Configure your real costs

Before trusting a plan, edit `../providers.json` with your actual electricity
rate and your real DigitalOcean (or other) GPU quotes, then redeploy. The
numbers shipped are placeholders.

## About GPU droplets

DigitalOcean offers GPU droplets. This service only tells you *when a cloud GPU
is the cheaper choice for a job you're authorized to run* — launching one, and
running hashcat on it, remains a separate manual step you control. If you want,
the repo owner can add a provisioning adapter, but it is intentionally not
included here.
