#!/usr/bin/env bash
#
# Build the cost-aware scheduler container and push it to DigitalOcean Container
# Registry (DOCR). Run this on YOUR machine — it needs a working Docker daemon
# and a doctl authenticated to your DO account. No secrets are baked into the
# image; runtime config (SCHEDULER_API_KEY, SCHED_USD_PER_KWH) is set on the app.
#
# Usage:
#   deploy/build-and-push.sh <registry-name> [tag]
# Example:
#   deploy/build-and-push.sh my-registry v1
#
# Then deploy with deploy/do-app-image.yaml (point its image.repository at the
# ref this script prints), or `doctl apps create --spec deploy/do-app-image.yaml`.

set -euo pipefail

REGISTRY="${1:-}"
TAG="${2:-latest}"
IMAGE_NAME="reactor-scheduler"

if [ -z "$REGISTRY" ]; then
  echo "usage: $0 <registry-name> [tag]" >&2
  echo "  create one first with: doctl registry create <registry-name>" >&2
  exit 2
fi

# Build context is the scheduler dir (the Dockerfile's directory), one up from here.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$(dirname "$SCRIPT_DIR")"
REF="registry.digitalocean.com/${REGISTRY}/${IMAGE_NAME}:${TAG}"

command -v docker >/dev/null || { echo "docker not found" >&2; exit 1; }
command -v doctl  >/dev/null || { echo "doctl not found — https://docs.digitalocean.com/reference/doctl/how-to/install/" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "docker daemon not running" >&2; exit 1; }

echo ">> logging in to DOCR (uses your doctl auth)"
doctl registry login

echo ">> building ${REF}"
docker build -t "${REF}" "${BUILD_DIR}"

echo ">> pushing ${REF}"
docker push "${REF}"

echo
echo "Pushed: ${REF}"
echo "Deploy it:"
echo "  1) edit deploy/do-app-image.yaml -> image.repository: ${REGISTRY}/${IMAGE_NAME}, tag: ${TAG}"
echo "  2) doctl apps create --spec backend/scheduler/deploy/do-app-image.yaml"
echo "  3) set SCHEDULER_API_KEY as an encrypted app-level secret before exposing it"
