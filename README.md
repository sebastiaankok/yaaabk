# YAAABK — Yet Another AI App Builder for Kubernetes

An AI-native Internal Developer Platform that takes a developer from idea to
deployed application on Kubernetes: brainstorm in an AI-driven grill-me session,
turn the refined plan into GitHub issues, and let autonomous agents implement
them.

- Product requirements: [`PRD.md`](./PRD.md)
- Implementation plan and architecture: [`PLAN.md`](./PLAN.md)
- Domain language: [`CONTEXT.md`](./CONTEXT.md)

## Requirements

- [Bun](https://bun.sh) **1.3+** — the only runtime needed for local development
- Docker — optional, only for the containerised stack

## Developing locally

```sh
git clone <repo-url> yaaabk
cd yaaabk
bun install   # installs every workspace package
bun run dev   # starts the frontend and backend together
```

`bun run dev` runs both servers with live reload; `Ctrl-C` stops both.

| Service | URL | What you should see |
| --- | --- | --- |
| Frontend | <http://localhost:5173> | Redirects to the first-run setup wizard |
| Backend | <http://localhost:3000> | `GET /health` → `{"status":"ok"}` |

The first time you open the frontend it walks you through creating the admin
account: choose a username and password, scan the TOTP QR code with an
authenticator app, then confirm a code. See [Authentication](#authentication).

No configuration is needed to start. To change defaults, copy the example file
to the repository root:

```sh
cp .env.example .env
```

| Variable | Default | Used by |
| --- | --- | --- |
| `PORT` | `3000` | Backend HTTP port |
| `YAAABK_DATA_DIR` | `./data` | Directory holding the SQLite database file |
| `YAAABK_AUTH_SECRET` | _generated_ | HS256 secret for session cookies; required in production |
| `YAAABK_WEB_ORIGIN` | `http://localhost:5173` | Frontend origin allowed to call the API with credentials |
| `YAAABK_GITHUB_TOKEN` | _unset_ | Token used to create Project repositories (`repo` scope, or a GitHub App with `administration:write`) |
| `YAAABK_GITHUB_OWNER` | _unset_ | Account new Project repositories are created under |
| `YAAABK_GITHUB_OWNER_TYPE` | `org` | Whether that account is an `org` or the authenticated `user` |
| `PUBLIC_API_BASE_URL` | `http://localhost:3000` | Frontend → backend base URL |
| `OPENROUTER_MANAGEMENT_KEY` | _unset_ | Management key used to provision a budgeted OpenRouter key per issue |
| `YAAABK_DEFAULT_ISSUE_BUDGET_CENTS` | `50` | Default per-issue budget in cents; overrides are capped at 500 |
| `YAAABK_AGENT_IMAGE` | `yaaabk/agent:0.1.0` | Container image the per-issue agent Jobs run |
| `YAAABK_API_URL` | _unset_ | Base URL an agent Job reports its result back to |
| `YAAABK_AGENT_POLL_MS` | `15000` | How often the Agent Manager reconciles in-flight Jobs |
| `YAAABK_CI_POLL_MS` | `30000` | How often the CI Tracker watches `automerge` pull requests |

A single root `.env` configures every package: the backend loads it via
`--env-file`, and Vite loads it via `envDir`. Only variables prefixed with
`PUBLIC_` are exposed to browser code. You can also override a value for one
command without editing the file, e.g. `PORT=4000 bun run dev`.

To work on one package at a time:

```sh
bun run --filter '@yaaabk/backend' dev    # backend only
bun run --filter '@yaaabk/frontend' dev   # frontend only
```

## Repository layout

This is a Bun workspace monorepo:

| Package | Path | What it is |
| --- | --- | --- |
| `@yaaabk/frontend` | `packages/frontend` | SvelteKit + Tailwind + shadcn-svelte browser UI |
| `@yaaabk/backend` | `packages/backend` | Bun + Hono REST API and SSE bridge |
| `@yaaabk/auth` | `packages/auth` | Password policy, TOTP, sessions and the `AuthStore` port |
| `@yaaabk/agent` | `packages/agent` | Per-issue agent that runs in a Kubernetes Job |
| `@yaaabk/k8s` | `packages/k8s` | Typed Kubernetes client (`createK8sClient`) and in-memory mock |
| `@yaaabk/template` | `packages/template` | Project scaffolder (`scaffold(project)`) with an injectable git backend |
| `@yaaabk/projects` | `packages/projects` | Project provisioning (`createProjectsModule`) and the `ProjectStore` port |
| `@yaaabk/issues` | `packages/issues` | Issue CRUD, the dependency graph (`buildIssueGraph`) and the `IssueStore` port |
| `@yaaabk/agents` | `packages/agents` | The Agent Manager: per-Issue K8s Jobs, concurrency limits and retries (`createAgentManager`) |
| `@yaaabk/ci-tracker` | `packages/ci-tracker` | The CI Tracker: watches `automerge` pull requests, merges the passing ones and spawns fix attempts (`createCiTracker`) |
| `@yaaabk/github` | `packages/github` | GitHub Issues and Pulls ports + REST adapters, the `createIssueSyncModule` mirror and fakes |
| `@yaaabk/cost-control` | `packages/cost-control` | Per-issue OpenRouter budgets (`open`/`topUp`/`status`/`release`) |
| `@yaaabk/shared` | `packages/shared` | Types and constants shared across packages |

Project templates live in [`templates/`](./templates). `@yaaabk/template` copies
the bundled [`templates/svelte-bun`](./templates/svelte-bun) — a SvelteKit +
Tailwind app served by a Bun + Hono API, with Docker, Kubernetes, ArgoCD and CI
wiring — interpolates the project's values, and pushes the result to the new
project repository.

Internal packages export TypeScript source directly and are bundled by their
consumers, so there is no separate compile step for `shared`.

## Authentication

YAAABK is single-user per instance. The `@yaaabk/auth` package owns the domain
logic — password policy (zxcvbn-backed), TOTP, sessions and an `AuthStore` port
with in-memory and SQLite adapters — while the backend exposes it over HTTP:

| Route | Purpose |
| --- | --- |
| `GET /api/auth/status` | Whether setup is complete and whether the caller is signed in |
| `POST /api/auth/setup` | Create the (unverified) admin account and TOTP secret |
| `POST /api/auth/setup/verify` | Confirm the TOTP code and sign in |
| `POST /api/auth/login` | Check the password, returning a second-factor challenge |
| `POST /api/auth/login/2fa` | Confirm the TOTP code and sign in |
| `POST /api/auth/logout` | Revoke the session |

Sessions are JWTs in an `HttpOnly`, `SameSite=Strict` cookie that expires after
seven days. Credential endpoints are limited to five attempts per minute. The
frontend `/setup` and `/login` pages drive the flow and a route guard bounces
signed-out Developers to the right step.

The first-run wizard needs an authenticator app (Google Authenticator, Authy,
1Password, …). In development an ephemeral signing secret is generated on each
start; set `YAAABK_AUTH_SECRET` (≥ 32 characters) to keep sessions across
restarts, and it is required in production.

## Projects

The `@yaaabk/projects` package owns Project provisioning: creating a Project
records it locally and, in one step, brings up everything it needs. The backend
exposes it over HTTP:

| Route | Purpose |
| --- | --- |
| `POST /api/projects` | Create a Project (`name`, `description`, `skillLevel`) |
| `GET /api/projects` | List Projects, newest first |
| `GET /api/projects/:id` | Get a Project |
| `PATCH /api/projects/:id` | Update its `description` and/or `skillLevel` |
| `DELETE /api/projects/:id` | Tear down its repository and cluster resources |

Creating a Project runs a fixed sequence, reported to the caller through the
`onProgress` callback:

1. **repository** — create the backing GitHub repository (the `Repository` port;
   a GitHub REST adapter ships with the module).
2. **scaffold** — push the `templates/svelte-bun` template to it.
3. **namespace** — create the `project-<short-uuid>` namespace, labelled
   `yaaabk.io/project-name`.
4. **service-account** and **role-binding** — the `yaaabk-agent` ServiceAccount
   bound to the `edit` ClusterRole within that namespace only.
5. **secret** — copy the GitHub token in as `yaaabk-github` (skipped when no
   token is configured).
6. **argocd** — create the ArgoCD `Application` for the repository.
7. **persist** — record the Project.

If any step fails the resources created so far are rolled back and no Project is
recorded, so a failed creation never leaves a half-registered Project.

The module depends on narrow ports, so it is unit-tested against an in-memory
`ProjectStore`, an in-memory cluster (`createMockK8sClient`), a fake repository
provider and the Template Module on a fake git backend. The SQLite store runs
against `bun:sqlite` under `bun test`:

```sh
bun run --filter '@yaaabk/projects' test:integration
```

## Issues

The `@yaaabk/issues` package owns Issues: the local mirror of the GitHub Issues a
Plan generates. The backend exposes it over HTTP:

| Route | Purpose |
| --- | --- |
| `POST /api/projects/:id/issues` | Create an Issue (`title`, `body`, `label`, `depends_on`, `budget_cents`) |
| `GET /api/projects/:id/issues` | List a Project's Issues, oldest first |
| `GET /api/projects/:id/issues/:issueId` | Get an Issue |
| `PATCH /api/projects/:id/issues/:issueId` | Update its `title`, `body`, `label`, `status` or `depends_on` |
| `DELETE /api/projects/:id/issues/:issueId` | Remove an Issue |
| `GET /api/projects/:id/issues/graph` | The dependency graph, with waves and any cycles |
| `POST /api/projects/:id/issues/generate` | Run the grill-me one-shot over the active Plan and record its Issues |
| `POST /api/projects/:id/issues/refine` | Re-run generation with revision feedback |
| `POST /api/projects/:id/issues/approve` | Mark every Issue `ready` |
| `GET /api/projects/:id/issues/sync/status` | How much of the Issue set is mirrored to GitHub |
| `POST /api/projects/:id/issues/sync/push` | Create or update the Project's Issues on GitHub |
| `POST /api/projects/:id/issues/sync/pull` | Pull GitHub's open/closed state back onto local Issues |
| `POST /api/projects/:id/issues/sync` | A full push-then-pull cycle |

The browser surface is `/projects/:id/issues/review`: the active Plan at the top,
the generated Issues grouped by wave (with label pills, dependency tags and any
circular-dependency warning), a "Refine with prompt" box, and "Approve & Create".
Issues are also recorded automatically whenever a live grill-me session emits an
`<ISSUES>` block.

`buildIssueGraph` resolves each Issue's `depends_on` titles to Issue ids, assigns
wave 0 to the Issues with no dependencies and one past their highest dependency
after that, and reports any cycle (or an Issue that transitively depends on one)
with no wave, so the UI can surface it. The module is unit-tested against an
in-memory `IssueStore` and the SQLite store runs against `bun:sqlite`:

```sh
bun run --filter '@yaaabk/issues' test:integration
```

### GitHub sync

`@yaaabk/github` mirrors each local Issue to a GitHub Issue on the Project's
repository. `push` opens a GitHub Issue for every local Issue that has none and
updates the rest; `pull` takes GitHub's open/closed state back, so an Issue a
human closes on GitHub closes locally too. YAAABK stays the source of truth for
everything else — title, body, labels, dependencies and budget — so the two
sides do not fight. The dependency titles and per-Issue budget ride along in an
invisible `<!-- yaaabk:meta … -->` footer that `push` writes and `pull` reads
past, so YAAABK-only fields survive a round trip.

An exhausted GitHub rate limit or a network failure is retried up to three times
with back-off; if it persists the route reports `429` (rate limited) or `502`
(any other GitHub error) rather than failing silently. The review page shows a
sync-status indicator and a **Sync with GitHub** button, and **Approve & Create**
pushes the freshly approved Issues.

The GitHub Issues port is unit-tested against an in-memory fake, and the REST
adapter against an injected `fetch`:

```sh
bun run --filter '@yaaabk/github' test:unit
```

## Agents

The `@yaaabk/agents` package owns the Agent Manager: the lifecycle of the
per-Issue Kubernetes Jobs that implement a Plan's Issues. The backend exposes it
over HTTP:

| Route | Purpose |
| --- | --- |
| `POST /api/projects/:id/issues/:issueId/spawn` | Schedule an attempt for an Issue |
| `GET /api/projects/:id/issues/:issueId/runs` | An Issue's attempts, oldest first |
| `GET /api/projects/:id/agent-runs` | A Project's attempts, newest first |
| `POST /api/agent-runs/:runId/report` | An agent Job reports its result, authenticated by its per-run token |

`spawn` creates the attempt's working PVC and Job (mounted at `/work`, with a
30-minute deadline) and flips the Issue to `in_progress`. At most **two** agents
run per Project and **ten** cluster-wide; an attempt that arrives over the limit
is recorded `queued` and dispatched by the reconcile loop as slots free. The loop
runs on a timer (`YAAABK_AGENT_POLL_MS`, default 15s) and, on a finished Job,
marks the attempt `success` and records the pull request URL, or marks it
`failed` and either schedules the next attempt or — once `maxAttempts` is reached
— labels the Issue `needs-human`. Credentials reach the Job through `envFrom`
Secret references, so YAAABK never reads their values.

Concurrency is enforced by reserving an attempt's slot synchronously before the
first cluster call, so two racing `spawn`s cannot both claim the last slot. The
module is unit-tested against the in-memory `AgentStore`, a mock cluster and the
real Issues Module; the SQLite store runs against `bun:sqlite`:

```sh
bun run --filter '@yaaabk/agents' test:integration
```

The `@yaaabk/agent` package is what the Job runs: it fetches the Issue, clones
the repository, runs OpenCode with the bundled `implement-issue` skill, runs the
project's checks, and opens a pull request labelled `automerge`. The clone →
implement → checks → PR flow is driven through narrow ports, so it is
unit-tested without a cluster, a repository or an LLM; the real adapters shell
out to `git`, OpenCode and the GitHub API.

## CI Tracker

The `@yaaabk/ci-tracker` package closes the agent loop. A background polling loop
(`createCiTracker`, started by the backend on boot) walks every Project, lists
the pull requests labelled `automerge`, and reads the combined check state of
each head commit through the `GitHubPulls` port:

- **passing** — the pull request is merged and its Issue is closed locally and on
  GitHub.
- **failing** — a fix attempt is spawned on the same branch, up to the Issue's
  attempt budget; once the budget is spent the Issue is labelled `needs-human`
  and no further attempts are made.
- **pending** — nothing yet; the tracker waits for CI to finish.

A still-failing head commit is remembered, so a fix is spawned exactly once per
commit. The pull request is mapped back to its Issue by its head branch
(`agent/issue-<n>`), the same convention the agent uses. The backend exposes the
loop over HTTP:

| Route | Purpose |
| --- | --- |
| `GET /api/admin/ci/status` | The loop's config, when it last checked, and the pull requests it watches |
| `PATCH /api/admin/ci/config` | Enable/disable the loop and change its interval (5s–24h) |

The module is unit-tested against the in-memory Issues Module and Agent Manager
and fakes for both GitHub ports:

```sh
bun run --filter '@yaaabk/ci-tracker' test:unit
```

## Scripts
Run these from the repository root; each fans out across the workspace.

| Command | Description |
| --- | --- |
| `bun run dev` | Start the frontend and backend dev servers together |
| `bun run build` | Build every package |
| `bun run test` | Run all unit tests (Vitest) |
| `bun run test:e2e:install` | Download the Playwright browser (once per machine) |
| `bun run test:e2e` | Run the Playwright end-to-end tests |
| `bun run typecheck` | Typecheck every package |
| `bun run lint` | Lint the whole repo with ESLint |
| `bun run format` | Format with Prettier |
| `bun run format:check` | Check formatting without writing |

To run a single package's script, use `--filter`, e.g.
`bun run --filter '@yaaabk/backend' test:unit`.

## Testing

Unit tests are fast and need no setup:

```sh
bun run test
```

End-to-end tests drive a real browser against the SvelteKit dev server
(booted automatically by Playwright). Install the browser once, then run them:

```sh
bun run test:e2e:install
bun run test:e2e
```

- **Unit tests** live beside the code as `*.test.ts` / `*.spec.ts` and run with
  [Vitest](https://vitest.dev). Tests exercise public behaviour through each
  module's interface.
- **End-to-end tests** live as `*.e2e.ts` and run with
  [Playwright](https://playwright.dev).
- **Kubernetes integration tests** (`@yaaabk/k8s`) are skipped by default and
  need a real cluster. Point them at a kind or minikube kubeconfig and run:

  ```sh
  bun run --filter '@yaaabk/k8s' test:integration
  ```

- **SQLite integration tests** (`@yaaabk/auth`) run the store against
  `bun:sqlite` under `bun test`:

  ```sh
  bun run --filter '@yaaabk/auth' test:integration
  ```

- **OpenRouter integration tests** (`@yaaabk/cost-control`) provision a real
  budgeted key against the Management API, then delete it. They need a
  management key and are skipped by default:

  ```sh
  OPENROUTER_MANAGEMENT_KEY=sk-or-... bun run --filter '@yaaabk/cost-control' test:integration
  ```

## Production build

```sh
bun run build                                   # build every package
bun run --filter '@yaaabk/frontend' preview     # serve the built frontend
```

The frontend build must run through Bun (`@sveltejs/adapter-bun`), which the
package scripts already handle.

## Containerised stack (optional)

```sh
docker compose up --build
```

This builds the backend and frontend images, exposes the frontend on
<http://localhost:5173>, and mounts a named volume for the SQLite data
directory. The OpenCode sidecar is added in a later slice.

## CI

`.github/workflows/ci.yml` runs on every push to `main` and on pull requests:
format check, lint, typecheck, unit tests, build, and end-to-end tests.
