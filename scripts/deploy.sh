#!/usr/bin/env bash
#
# Build, push and roll out YAAABK to the k3s-home cluster.
#
# Usage:
#   scripts/deploy.sh <tag>                  # build, push, deploy
#   SKIP_BUILD=1 scripts/deploy.sh <tag>     # re-apply and pin an existing tag
#   KUBE_CONTEXT=other scripts/deploy.sh ... # override the kubeconfig context
#   cat deploy/VERSION                       # the last released version
#
# The tag is required so a rollout is always deliberate and traceable. Read the
# last release from deploy/VERSION and bump its patch, e.g. `scripts/deploy.sh
# 0.1.43`. Images are built for linux/amd64 (the cluster node's architecture),
# not the builder's native platform.
#
# After a successful rollout the script writes the tag to deploy/VERSION, so
# that file always names the release that is actually running and the next
# release is a patch bump on it. Commit the file with the release; a deploy
# that re-applies an older tag (a rollback) rewrites it to that tag.
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
VERSION_FILE="${VERSION_FILE:-deploy/VERSION}"

if [ -z "$TAG" ]; then
  echo "usage: scripts/deploy.sh <tag>   # e.g. 0.1.43" >&2
  if [ -f "$VERSION_FILE" ]; then
    echo "last release: $(tr -d '[:space:]' <"$VERSION_FILE") (in $VERSION_FILE)" >&2
  fi
  exit 1
fi

is_semver() {
  [[ "$1" =~ ^[0-9]+(\.[0-9]+)*$ ]]
}

# Compare two numbered versions and print -1 (older), 0 (same) or 1 (newer).
# Lexicographic comparison would rank 0.1.9 above 0.1.42, hence the split.
version_cmp() {
  local -a a b
  local i x y
  IFS=. read -r -a a <<<"$1"
  IFS=. read -r -a b <<<"$2"
  for i in 0 1 2 3; do
    x="${a[$i]:-0}"
    y="${b[$i]:-0}"
    if [ "$((10#$x))" -gt "$((10#$y))" ]; then
      echo 1
      return
    fi
    if [ "$((10#$x))" -lt "$((10#$y))" ]; then
      echo -1
      return
    fi
  done
  echo 0
}

next_version() {
  local -a p
  IFS=. read -r -a p <<<"$1"
  echo "${p[0]:-0}.${p[1]:-0}.$((10#${p[2]:-0} + 1))"
}

# The version file records the last successful deploy: the next release is a
# patch bump on it. Re-applying the same tag is fine; going backwards is
# probably a rollback, so say so out loud.
last_version=""
if [ -f "$VERSION_FILE" ]; then
  last_version="$(tr -d '[:space:]' <"$VERSION_FILE")"
fi
if [ -z "$last_version" ]; then
  echo "▶ no $VERSION_FILE yet; $TAG will be recorded once the rollout succeeds"
elif ! is_semver "$TAG" || ! is_semver "$last_version"; then
  echo "▶ deploying $TAG (cannot compare it with '$last_version' in $VERSION_FILE)"
else
  case "$(version_cmp "$TAG" "$last_version")" in
    0) echo "▶ $TAG is already recorded in $VERSION_FILE; re-applying it" ;;
    -1) echo "! $TAG is older than $last_version in $VERSION_FILE (a rollback?)" >&2 ;;
    *) echo "▶ $last_version → $TAG" ;;
  esac
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
  local target="${3:-}"
  if [ "$SKIP_BUILD" = "1" ]; then
    echo "▶ skipping build of $name:$TAG"
    return
  fi
  local target_args=()
  if [ -n "$target" ]; then
    target_args=(--target "$target")
  fi
  echo "▶ building $name:$TAG ($PLATFORM${target:+ from $target})"
  docker buildx build \
    --platform "$PLATFORM" \
    --pull \
    -f "$dockerfile" \
    ${target_args[@]+"${target_args[@]}"} \
    -t "$REGISTRY/yaaabk-$name:$TAG" \
    --push .
}

# Production runs grill sessions as Kubernetes Pods, so the backend image is the
# `runtime` stage: no ttyd or OpenCode download. The dev stage is only for
# docker compose.
build_and_push backend packages/backend/Dockerfile runtime
build_and_push frontend packages/frontend/Dockerfile
build_and_push agent packages/agent/Dockerfile

echo "▶ applying manifests with tag $TAG"
# Render the kustomization and inject the release tag at apply time, so a
# rollout never passes through the baseline tag in deploy/*.yaml.
rendered="$(mktemp)"
trap 'rm -f "$rendered"' EXIT
kubectl kustomize deploy \
  | sed -E \
    -e "s#(image: ${REGISTRY}/yaaabk-(backend|frontend|agent)):[A-Za-z0-9._-]+#\1:${TAG}#g" \
    -e "s#(value: ${REGISTRY}/yaaabk-agent):[A-Za-z0-9._-]+#\1:${TAG}#g" \
  >"$rendered"

# Dry-run first: a rejected manifest halfway through `apply` leaves the cluster
# on a mix of old and new images (e.g. a field in the wrong nesting level).
kubectl --context "$CONTEXT" apply --dry-run=server -f "$rendered" >/dev/null
kubectl --context "$CONTEXT" apply -f "$rendered"

echo "▶ waiting for rollout"
# The manifests pin namespace yaaabk; don't rely on the kubeconfig context's
# default namespace, which can point at a Project namespace.
kubectl --context "$CONTEXT" -n yaaabk rollout status deployment/yaaabk-backend --timeout=5m
kubectl --context "$CONTEXT" -n yaaabk rollout status deployment/yaaabk-frontend --timeout=5m

# Record the tag only after the rollout succeeds: the file names the release
# that is actually running, so an aborted deploy never skips a version.
printf '%s\n' "$TAG" >"$VERSION_FILE"

kubectl --context "$CONTEXT" -n yaaabk get pods
echo "✓ deployed $TAG"
echo "  recorded $TAG in $VERSION_FILE"
if is_semver "$TAG"; then
  echo "  next release: $(next_version "$TAG")"
fi
echo "  commit $VERSION_FILE with the release"

