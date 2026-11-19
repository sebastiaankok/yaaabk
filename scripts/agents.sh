#!/usr/bin/env bash
#
# Drive the issue -> PR -> merge -> deploy agent over the open backlog.
#
# Every iteration re-reads GitHub, picks the lowest-numbered eligible issue and
# runs OpenCode once for it, until nothing is left to do.
#
# Eligible = open, unassigned, and not mentioned by any open PR. The agent
# deliberately writes "Refs #<n>" (never "Closes"), so an issue stays open until
# its deploy succeeded: an open PR mentioning it therefore means "in flight".
#
# Usage:
#   scripts/agents.sh
#   DRY_RUN=1 scripts/agents.sh          # list what would run, change nothing
#   CONTINUE_ON_ERROR=1 scripts/agents.sh
#
# Stops when:
#   - the hard cap of 20 iterations is reached (deliberate; this burns tokens)
#   - no eligible issue is left, or every remaining one was already tried here
#   - an iteration exits non-zero, unless CONTINUE_ON_ERROR=1
#   - the working tree is dirty, so a half-finished run is not papered over

set -euo pipefail

# Hard cap. Not configurable on purpose: an unattended loop must always end.
readonly MAX_ITERATIONS=20

readonly MODEL="${MODEL:-opencode-go/deepseek-v4.1-flash}"
DRY_RUN="${DRY_RUN:-0}"
CONTINUE_ON_ERROR="${CONTINUE_ON_ERROR:-0}"
SLEEP_SECONDS="${SLEEP_SECONDS:-10}"

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

for cmd in gh opencode; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "missing required command: $cmd" >&2
    exit 1
  }
done

log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }

# Titles and bodies of open PRs, one per line.
open_pr_text() {
  gh pr list --state open --limit 500 --json title,body \
    --jq '.[] | (.title // "") + " " + (.body // "")'
}

# Numbers of eligible issues, ascending.
eligible_issues() {
  local refs n
  refs="$(open_pr_text)"
  gh issue list --state open --limit 500 --json number,assignees \
    --jq '.[] | select((.assignees | length) == 0) | .number' |
    sort -n |
    while IFS= read -r n; do
      [ -n "$n" ] || continue
      if grep -Eq "(^|[^0-9])#${n}([^0-9]|$)" <<<"$refs"; then
        log "skip #$n: an open PR already references it" >&2
        continue
      fi
      echo "$n"
    done
}

prompt_for() {
  cat <<EOF
Load the tdd skill and follow it. Implement GitHub issue #$1 - and only that issue; do not pick another one.

Work on branch agent/<slug>, run bun test, lint, typecheck and build, push, and open a PR whose body says "Refs #$1" (do NOT write "Closes #$1"; GitHub would close it on merge, before deploy). Enable auto-merge squash. Then poll gh pr view <pr> --json state,mergedAt every 30s for at most 30 minutes; if it is not merged by then, stop and report.

After merge: git checkout main && git pull, then deploy with scripts/deploy.sh <next patch tag>. Only if the deploy exits 0, comment the deploy tag on the issue and close it if still open.

If the issue is already fixed or not worth implementing, say so and stop instead of inventing work: leave it open, open no PR, and exit 0.
EOF
}

if [ "$DRY_RUN" = "1" ]; then
  echo "eligible issues (of $(gh issue list --state open --limit 500 --json number --jq 'length') open):"
  eligible_issues | sed 's/^/  #/'
  echo "would run at most $MAX_ITERATIONS iteration(s) with $MODEL"
  exit 0
fi

attempted=()

in_attempted() {
  local n="$1" a
  for a in ${attempted[@]+"${attempted[@]}"}; do
    [ "$a" = "$n" ] && return 0
  done
  return 1
}

iteration=0
while [ "$iteration" -lt "$MAX_ITERATIONS" ]; do
  candidates=()
  while IFS= read -r n; do
    [ -n "$n" ] && candidates+=("$n")
  done < <(eligible_issues)

  issue=""
  for n in ${candidates[@]+"${candidates[@]}"}; do
    if in_attempted "$n"; then
      log "skip #$n: already attempted in this run"
      continue
    fi
    issue="$n"
    break
  done

  if [ -z "$issue" ]; then
    log "no eligible issue left (still open upstream: $(gh issue list --state open --limit 500 --json number --jq 'length'))"
    break
  fi

  # A dirty tree means a previous run died mid-work or someone is editing.
  # Either way, switching branches from here would mix unrelated changes.
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    log "working tree has uncommitted changes; stopping (see git status)"
    exit 1
  fi

  iteration=$((iteration + 1))
  log "iteration $iteration/$MAX_ITERATIONS: issue #$issue"

  if opencode run \
    -m "$MODEL" \
    --auto --thinking \
    --title "issue #$issue -> PR -> merge -> deploy" \
    "$(prompt_for "$issue")"; then
    log "issue #$issue: agent finished"
  else
    status=$?
    log "issue #$issue: agent exited $status"
    [ "$CONTINUE_ON_ERROR" = "1" ] || exit "$status"
  fi

  attempted+=("$issue")

  if [ "$iteration" -lt "$MAX_ITERATIONS" ]; then
    sleep "$SLEEP_SECONDS"
  fi
done

if [ "$iteration" -ge "$MAX_ITERATIONS" ]; then
  log "reached the hard cap of $MAX_ITERATIONS iterations; stopping"
fi

log "done after $iteration iteration(s)"
