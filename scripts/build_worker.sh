#!/usr/bin/env bash
# Build the Image Studio RunPod worker image (linux/amd64) and push it.
#
#   WORKER_IMAGE=ghcr.io/<you>/image-studio-worker scripts/build_worker.sh
#   WORKER_IMAGE=docker.io/<you>/image-studio-worker:dev scripts/build_worker.sh --load   # local only, no push
#
# Needs Docker with buildx: Docker Desktop, OrbStack or colima (`colima start --cpu 4 --memory 8 --disk 100`).
# On Apple Silicon the amd64 build runs under emulation: slow but works. The base image is ~15 GB
# compressed (~30+ GB unpacked), so give the Docker VM at least ~80 GB of disk.
# Log in first: `echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin`
# (a classic PAT with write:packages), or `docker login` for Docker Hub.
# If WORKER_IMAGE has no tag, it is pushed as :latest and :<git short sha>.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="--push"
case "${1:-}" in
  --load) MODE="--load" ;;
  --push|"") ;;
  -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
  *) echo "usage: WORKER_IMAGE=... $0 [--push|--load]" >&2; exit 2 ;;
esac

: "${WORKER_IMAGE:?set WORKER_IMAGE, e.g. ghcr.io/<owner>/image-studio-worker}"
command -v docker >/dev/null || { echo "docker not found (install Docker Desktop, OrbStack or colima)" >&2; exit 1; }
docker buildx version >/dev/null 2>&1 || { echo "docker buildx not available" >&2; exit 1; }
[ -f "$ROOT/worker/Dockerfile" ] || { echo "missing $ROOT/worker/Dockerfile" >&2; exit 1; }

# Tag handling: a tag is the part after the last ':' that follows the last '/'.
last="${WORKER_IMAGE##*/}"
tags=()
if [[ "$last" == *:* ]]; then
  tags+=(-t "$WORKER_IMAGE")
else
  sha="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo dev)"
  tags+=(-t "$WORKER_IMAGE:latest" -t "$WORKER_IMAGE:$sha")
fi

echo "Building ${tags[*]} (linux/amd64, context $ROOT, mode $MODE)"
docker buildx build \
  --platform linux/amd64 \
  -f "$ROOT/worker/Dockerfile" \
  --provenance=false \
  "${tags[@]}" \
  "$MODE" \
  "$ROOT"

echo "Done. Use it with: python3 scripts/runpod_setup.py --image ${tags[1]}"
