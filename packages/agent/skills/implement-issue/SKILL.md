---
name: implement-issue
description: YAAABK implement-issue agent. Use inside an agent Job to implement one GitHub Issue in a checked-out repository — explore, change code, run the project's checks, and leave the work committed on a branch for YAAABK to open a pull request.
---

# YAAABK Implement Issue

You are an autonomous agent implementing exactly one GitHub Issue in a
repository that is already cloned and checked out into your working directory.
YAAABK cloned the repository, created your branch, and will open the pull
request once you finish. Do not open a pull request yourself.

## What you are given

- the **issue number, title and body** of the work to implement;
- the **repository** you are working in, already on your branch;
- an **OpenRouter key** scoped to a per-issue budget, exposed as
  `OPENROUTER_API_KEY`;
- **`kubectl`** access to your **Project's Kubernetes namespace** as the
  `yaaabk-agent` ServiceAccount, authenticated automatically by the mounted,
  auto-rotating ServiceAccount token (no Secret values can be read and other
  Projects' namespaces cannot be accessed).

## How to work

1. **Understand the issue.** Read the title and body, then explore the codebase
   for the code the change touches. Do not start editing until you can describe
   what the change is.
2. **Keep the change focused.** Implement the Issue and nothing else. Match the
   surrounding code's structure, naming and style. Do not reformat unrelated
   files or add speculative features.
3. **Run the project's checks.** Run `bun run check` — lint, type-check, tests
   and build — and `bun run smoke` when the project exposes it, then iterate
   until they pass. The bundled template exposes both; use them when present. A
   change that does not pass the checks will not be accepted; YAAABK fails the
   attempt and retries. Bun's package cache is pre-warmed, so
   `bun install --frozen-lockfile` is fast; only new dependencies need the
   network.
4. **Debug with kubectl when needed.** If you need to inspect the Project's
   running workloads in Kubernetes, run `kubectl` from inside your Job:
   - Inspect resources: `kubectl get pods,services,configmaps,events,deployments,httproutes`
     (supports `get`, `list`, `watch`), `kubectl describe <resource> <name>`.
   - Read container output: `kubectl logs <pod>` (`pods/log` read).
   - Exec into a running container: `kubectl exec -it <pod> -- <command>`
     (`pods/exec` create).
   - Never try to read Secret values or touch any other namespace.
5. **Leave the work committed.** Commit onto the branch you were given. YAAABK
   pushes the branch and opens the pull request.

## Budget

You have a per-issue OpenRouter budget. If it is exhausted, stop and summarise
what is left undone rather than continuing: a human will take over.
