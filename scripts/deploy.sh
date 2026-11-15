#!/usr/bin/env bash
#
# Build, push and roll out YAAABK to the k3s-home cluster.
#
# Usage:
#   scripts/deploy.sh <tag>                  # build, push, deploy
#   SKIP_BUILD=1 scripts/deploy.sh <tag>     # re-apply and pin an existing tag
#   KUBE_CONTEXT=other scripts/deploy.sh ... # override the kubeconfig context
#
# The tag is required so a rollout is always deliberate and traceable, e.g.
# `scripts/deploy.sh 0.1.1`. Images are built for linux/amd64 (the cluster
# node's architecture), not the builder's native platform.
#
# The checked-in manifests pin 0.1.0 as their local baseline; this script
# injects <tag> at apply time, so re-applying `kubectl apply -k deploy` by hand
# would fall back to that baseline.
#
# Requires: docker (with buildx), kubectl, a kubeconfig context, and push
# access to ghcr.io.

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

TAG="${1:-${IMAGE_TAG:-}}"
CONTEXT="${KUBE_CONTEXT:-k3s-home}"
OWNER="${GHCR_OWNER:-sebastiaankok}"
REGISTRY="ghcr.io/$OWNER"
PLATFORM="${PLATFORM:-linux/amd64}"
SKIP_BUILD="${SKIP_BUILD:-0}"

if [ -z "$TAG" ]; then
  echo "usage: scripts/deploy.sh <tag>   # e.g. 0.1.1" >&2
  exit 1
fi

for cmd in docker kubectl; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "missing required command: $cmd" >&2
    exit 1
  }
done

build_and_push() {
  local name="$1"
  local dockerfile="$2"
  if [ "$SKIP_BUILD" = "1" ]; then
    echo "▶ skipping build of $name:$TAG"
    return
  fi
  echo "▶ building $name:$TAG ($PLATFORM)"
  docker buildx build \
    --platform "$PLATFORM" \
    --pull \
    -f "$dockerfile" \
    -t "$REGISTRY/yaaabk-$name:$TAG" \
    --push .
}

build_and_push backend packages/backend/Dockerfile
build_and_push frontend packages/frontend/Dockerfile
build_and_push agent packages/agent/Dockerfile

echo "▶ applying manifests with tag $TAG"
# Render the kustomization and inject the release tag at apply time, so a
# rollout never passes through the baseline tag in deploy/*.yaml.
kubectl kustomize deploy \
  | sed -E \
    -e "s#(image: ${REGISTRY}/yaaabk-(backend|frontend|agent)):[A-Za-z0-9._-]+#\1:${TAG}#g" \
    -e "s#(value: ${REGISTRY}/yaaabk-agent):[A-Za-z0-9._-]+#\1:${TAG}#g" \
  | kubectl --context "$CONTEXT" apply -f -
kubectl --context "$CONTEXT" apply -f deploy/appproject.yaml

echo "▶ waiting for rollout"
kubectl --context "$CONTEXT" rollout status deployment/yaaabk-backend --timeout=5m
kubectl --context "$CONTEXT" rollout status deployment/yaaabk-frontend --timeout=5m

kubectl --context "$CONTEXT" -n yaaabk get pods
echo "✓ deployed $TAG"
