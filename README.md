# YAAABK — Yet Another AI App Builder for Kubernetes

An AI-native Internal Developer Platform that takes a developer from idea to
deployed application on Kubernetes: grill your idea in an interactive terminal
session that produces a PRD-shaped Plan and its Issues, then let autonomous
agents implement them.

- Product requirements: [`PRD.md`](./PRD.md)
- Implementation plan and architecture: [`PLAN.md`](./PLAN.md)
- Domain language: [`CONTEXT.md`](./CONTEXT.md)

## Requirements

- [Bun](https://bun.sh) **1.3+** — the only runtime needed for local development
- Docker — optional, only for the containerised stack
- For local Grill-Me sessions: [`ttyd`](https://github.com/tsl0922/ttyd),
  [`tmux`](https://github.com/tmux/tmux) and [OpenCode](https://opencode.ai) on
  `PATH`, plus an OpenRouter management key in Settings or
  `OPENROUTER_MANAGEMENT_KEY`. `docker compose up` provides all three binaries in
  the backend image.

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

No configuration is needed to start the app. Grill-Me sessions additionally need
an OpenRouter management key (Settings or `OPENROUTER_MANAGEMENT_KEY`) and the
two binaries above. To change defaults, copy the example file to the repository
root:

```sh
cp .env.example .env
```

| Variable | Default | Used by |
| --- | --- | --- |
| `PORT` | `3000` | Backend HTTP port |
| `YAAABK_DATA_DIR` | `./data` | Directory holding the SQLite database file |
| `YAAABK_AUTH_SECRET` | _generated_ | HS256 secret for session cookies; required in production |
| `YAAABK_WEB_ORIGIN` | `http://localhost:5173` | Frontend origin allowed to call the API with credentials |
| `YAAABK_GITHUB_TOKEN` | _unset_ | Fallback token used to create Project repositories (`repo` scope, or a GitHub App with `administration:write` / `repository_creation:write`) |
| `YAAABK_GITHUB_OWNER` | _unset_ | **Required**: account new Project repositories are created under. For a GitHub App, the account it is installed on. |
| `YAAABK_GITHUB_OWNER_TYPE` | `org` | Whether that account is an `org` or the authenticated `user` |
| `PUBLIC_API_BASE_URL` | `http://localhost:3000` | Frontend → backend base URL |
| `OPENROUTER_MANAGEMENT_KEY` | _unset_ | Management key used to provision a budgeted OpenRouter key per Issue and Grill-Me Session |
| `YAAABK_DEFAULT_ISSUE_BUDGET_CENTS` | `100` | Default per-Issue or per-Session budget in cents; overrides are capped at 500 |
| `YAAABK_DEFAULT_MODEL` | `openrouter/anthropic/claude-sonnet-4.5` | Fallback model when no session choice, Project agent model or Issue override applies |
| `YAAABK_AGENT_IMAGE` | `yaaabk/agent:0.1.0` | Container image the per-issue agent Jobs run |
| `YAAABK_AGENT_STORAGE_CLASS` | _cluster default_ | StorageClass an agent's working PVC requests; required when the cluster has no default StorageClass |
| `YAAABK_SESSION_RUNTIME` | auto | `kubernetes` or `local`; auto-detected from `KUBERNETES_SERVICE_HOST`. Deployed instances use Pods in the Project Namespace. |
| `YAAABK_SESSION_IMAGE` | `YAAABK_AGENT_IMAGE` | Shared OpenCode + ttyd image session Pods run |
| `YAAABK_SESSION_API_URL` | `YAAABK_API_URL` | Backend base URL a session's reporting MCP server posts to |
| `YAAABK_SESSION_IDLE_TIMEOUT_MS` | `1800000` | How long a session may go without terminal traffic before it is reaped |
| `YAAABK_SESSION_MAX_MS` | `14400000` | Hard cap on a session's lifetime, measured from its start |
| `YAAABK_SESSION_SWEEP_MS` | `60000` | How often the backend checks for sessions to reap; `0` disables it |
| `YAAABK_NAMESPACE` | `yaaabk` | Namespace the backend runs in; session NetworkPolicies allow it |
| `YAAABK_API_URL` | _unset_ | Base URL an agent Job reports its result back to |
| `YAAABK_AGENT_POLL_MS` | `15000` | How often the Agent Manager reconciles in-flight Jobs |
| `YAAABK_CI_POLL_MS` | `30000` | How often the CI Tracker watches `automerge` pull requests |

A single root `.env` configures every package: the backend loads it via
`--env-file`, and Vite loads it via `envDir`. Only variables prefixed with
`PUBLIC_` are exposed to browser code. You can also override a value for one
command without editing the file, e.g. `PORT=4000 bun run dev`.

The default budget is **$1.00**, sized to cover one maximum-length reply from the
default Claude Sonnet 4.5 model: OpenRouter reserves 64,000 completion tokens at
$15 per million, or $0.96, against the key before streaming. We keep Sonnet as
the default model and raise the budget rather than capping replies or switching
to a cheaper model, so a fresh Project needs no configuration. A lower
configured budget paired with a pricier model is still refused at session or
Agent start with both amounts and what to change. See
[ADR 0001](./docs/adr/0001-affordable-default-budget.md).

### Connecting GitHub

Create a Project needs two things: an **account to create repositories under**
(`YAAABK_GITHUB_OWNER`) and **credentials**. Registering a GitHub App is not the
same as installing it — an App only holds a token for the installation it was
granted, so all three of App ID, private key and **Installation ID** are
required:

1. Create the App at <https://github.com/settings/apps> and give it
   **Administration: read/write** (repository creation) plus Contents, Issues,
   Pull requests, **Workflows** and Metadata. Workflows is required because the
   scaffold ships a `.github/workflows/ci.yml`: without it GitHub rejects the
   first push with "refusing to allow a GitHub App to create or update workflow
   … without `workflows` permission".
2. **Install** it on the account that will own the repositories, then copy the
   installation id from the confirmation URL — `.../installations/<id>`.
3. Paste the App ID, private key and Installation ID into **Settings**.

The Settings page reports what is missing rather than failing later: an App
without an Installation ID is called out by name, since it can never mint a
token. `YAAABK_GITHUB_TOKEN` (a PAT with the `repo` scope) remains a fallback
for local development.

The OpenRouter section shows the account's remaining credits and the default
model's worst-case reply reservation. When the balance cannot cover one reply,
it says so before a run starts and names the fix: add credits or choose a free
model.

To work on one package at a time:

```sh
bun run --filter '@yaaabk/backend' dev    # backend only
bun run --filter '@yaaabk/frontend' dev   # frontend only
```

## Git hooks

A pre-commit hook runs the same fast validations as CI (Prettier, ESLint,
typecheck, unit tests) plus a [`gitleaks`](https://github.com/gitleaks/gitleaks)
secret scan of the staged changes. Enable it once per clone:

```sh
bun run hooks:install    # sets core.hooksPath to scripts/git-hooks
```

Install gitleaks so the secret scan runs locally (CI enforces it regardless):

```sh
# macOS (Homebrew) or see the gitleaks README for other platforms
brew install gitleaks
```

The slower CI steps are opt-in per commit:

```sh
PRECOMMIT_FULL=1 git commit ...   # + build + SQLite integration tests
PRECOMMIT_E2E=1  git commit ...   # + Playwright end-to-end tests
```

## Repository layout

This is a Bun workspace monorepo:

| Package | Path | What it is |
| --- | --- | --- |
| `@yaaabk/frontend` | `packages/frontend` | SvelteKit + Tailwind + shadcn-svelte browser UI |
| `@yaaabk/backend` | `packages/backend` | Bun + Hono REST API and terminal WebSocket bridge |
| `@yaaabk/auth` | `packages/auth` | Password policy, TOTP, sessions and the `AuthStore` port |
| `@yaaabk/agent` | `packages/agent` | Per-issue agent that runs in a Kubernetes Job |
| `@yaaabk/k8s` | `packages/k8s` | Typed Kubernetes client (`createK8sClient`) and in-memory mock |
| `@yaaabk/template` | `packages/template` | Project scaffolder (`scaffold(project)`) with an injectable git backend |
| `@yaaabk/projects` | `packages/projects` | Project provisioning (`createProjectsModule`) and the `ProjectStore` port |
| `@yaaabk/plans` | `packages/plans` | Versioned Plans (`createPlansModule`) and the `PlanStore` port |
| `@yaaabk/grill-me` | `packages/grill-me` | Grill-Me terminal sessions, reporting drafts, Plan/Issue publishing, the `SessionRuntime` port with local and Kubernetes adapters, and the terminal protocol |
| `@yaaabk/grill-mcp` | `packages/grill-mcp` | The stdio MCP server a Grill-Me Session runs next to OpenCode (`report_prd`, `report_issues`, `session_status`) |
| `@yaaabk/issues` | `packages/issues` | Issue CRUD, the dependency graph (`buildIssueGraph`) and the `IssueStore` port |
| `@yaaabk/agents` | `packages/agents` | The Agent Manager: per-Issue K8s Jobs, concurrency limits and retries (`createAgentManager`) |
| `@yaaabk/stats` | `packages/stats` | Pure Project statistics (`computeProjectStats`): issue counts, velocity, agent success, cost and durations |
| `@yaaabk/ci-tracker` | `packages/ci-tracker` | The CI Tracker: watches `automerge` pull requests, merges the passing ones and spawns fix attempts (`createCiTracker`) |
| `@yaaabk/github` | `packages/github` | GitHub Issues and Pulls ports + REST adapters, the `createIssueSyncModule` mirror and fakes |
| `@yaaabk/cost-control` | `packages/cost-control` | Per-issue OpenRouter budgets (`open`/`topUp`/`status`/`summary`/`release`) |
| `@yaaabk/shared` | `packages/shared` | Types and constants shared across packages |

Project templates live in [`templates/`](./templates). `@yaaabk/template` copies
the bundled [`templates/svelte-bun`](./templates/svelte-bun) — a SvelteKit +
Tailwind app served by a Bun + Hono API, with Docker, Kubernetes (HTTPRoute) and
CI wiring — interpolates the project's values, and pushes the result to the new
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
| `PATCH /api/projects/:id` | Update its `description`, `skillLevel` and/or `agentModel` |
| `DELETE /api/projects/:id` | Tear down its repository, cluster resources, Plans and Issues |

Project repositories are created **public**: the scaffold is AI-generated, and a
public repository lets its GHCR image package inherit public visibility so the
cluster can pull it anonymously.

Creating a Project runs a fixed sequence, reported to the caller through the
`onProgress` callback:

1. **repository** — create the backing GitHub repository (the `Repository` port;
   a GitHub REST adapter ships with the module).
2. **scaffold** — push the `templates/svelte-bun` template to it.
3. **namespace** — create the `yaaabk-<short-uuid>` namespace with the `restricted`
   Pod Security Admission labels and `yaaabk.io/project-name`.
4. **rbac** — create the `yaaabk-agent` (read-only plus `pods/exec`) and
   `yaaabk-deploy` (write on `deployments`, `services`, `configmaps`, `secrets`,
   `httproutes` and read on `pods`/`pods/log`) ServiceAccounts, and bind each to
   the fixed `yaaabk-project-agent`/`yaaabk-project-deploy` ClusterRoles with a
   RoleBinding inside the Project namespace.
5. **persist** — record the Project.

If any step fails the resources created so far are rolled back and no Project is
recorded, so a failed creation never leaves a half-registered Project.

The module depends on narrow ports, so it is unit-tested against an in-memory
`ProjectStore`, an in-memory cluster (`createMockK8sClient`), a fake repository
provider and the Template Module on a fake git backend. The SQLite store runs
against `bun:sqlite` under `bun test`:

```sh
bun run --filter '@yaaabk/projects' test:integration
```

## Grill-Me sessions

A Grill-Me Session runs `opencode mini` behind ttyd in a session runtime, and the
Plan page hosts an xterm.js terminal for it. The agent hands its work back
through the reporting MCP server the image ships, not through stdout markers:

The runtime port has two adapters. Host development spawns ttyd and OpenCode as
local child processes. A deployment creates one hardened Pod per session in the
Project Namespace, running as the Project's `yaaabk-agent` ServiceAccount under
Pod Security `restricted` with explicit CPU and memory limits. An init container
clones the Project repository with a short-lived `contents:read` GitHub token,
then rewrites the remote to a credential-free URL; the token Secret is mounted
only into that init container. The main container runs ttyd in front of a tmux
session that holds `opencode mini` in `/workspace/repo` with the opening prompt,
the selected model and replay enabled. ttyd starts one command per client and
signals it on disconnect; tmux keeps the agent alive, so a dropped terminal
bridge reconnects to the same conversation instead of restarting the interview.
The terminal is reachable only through the backend proxy, and a NetworkPolicy
allows ingress from the backend pod alone and egress only to the backend, the
Kubernetes API, GitHub/OpenRouter over HTTPS and DNS. The agent can inspect the
repository and the Project's workloads with read-only `kubectl` plus
`pods/exec`, but cannot read Secrets or mutate workloads, and its OpenCode
deny-list blocks `git push`, destructive `kubectl` verbs, `.env` reads and
writes outside the workspace.

| Route | Purpose |
| --- | --- |
| `GET /api/models` | The live OpenRouter catalogue filtered to tool-capable models, plus the default model |
| `POST /api/projects/:id/grill` | Start a session with an optional model, replacing the Project's previous one |
| `GET /api/projects/:id/grill` | The live session, or 404 when none is running |
| `GET /api/projects/:id/grill/:sessionId/terminal` | Upgrade to the terminal WebSocket |
| `POST /api/grill-sessions/:sessionId/report` | Store a PRD and/or Issue list as drafts (session bearer token) |
| `GET /api/grill-sessions/:sessionId/status` | Read the status and draft counts (session bearer token) |
| `POST /api/projects/:id/grill/:sessionId/finish` | Publish the drafts as one Plan version and its Issues |
| `POST /api/projects/:id/grill/:sessionId/cancel` | Discard the drafts and stop the session |

Reporting never touches Plans or Issues. **Finish** is the only publish point:
it creates one Plan (labelled "Plan (PRD)" in the UI), then replaces that Plan's
Issues. Without a PRD and at least one Issue it answers `409` with the missing
drafts, and a `force` request publishes what exists. The session remembers the
Plan it created, so retrying Finish after a failed Issue publish reuses that
version instead of creating another. Cancel leaves no trace.

Starting a session mints a budget-limited, expiring OpenRouter key for it. The
plaintext key goes only into the runtime as `OPENROUTER_API_KEY`; the session
stores only its hash and revokes it on Finish, Cancel, replacement or a failed
start. The model is the start request's choice, then the Project's last-used
model, then `YAAABK_DEFAULT_MODEL`; a requested model outside the tool-capable
catalogue is rejected with a `400`. Before minting, the selected model's
worst-case reply — its full `max_completion_tokens` at the completion price — is
checked against the budget and the account's remaining OpenRouter credits.
OpenRouter reserves that much up front, so a paid model that cannot cover one
reply is refused at start with the required amount and what to change; free
models need no balance.

The session runtime also injects `YAAABK_API_URL`, `YAAABK_SESSION_ID` and a
per-session `YAAABK_REPORT_TOKEN`; the report routes accept that bearer token
instead of the Developer's cookie. `packages/grill-mcp` exposes `report_prd`,
`report_issues` and `session_status` over stdio, and the image's session OpenCode
config registers it with `codemode: false` so the model calls those tools
directly. `YAAABK_SESSION_OPENCODE_CONFIG` scopes the config to sessions, so
Agent Jobs never register a server they have no token for.

The opening prompt tells the agent to load the image-baked `grill-me` skill
before anything else. The interview then hands off automatically: `grill-me`
confirms the settled plan, `to-prd` synthesises the PRD and checks its module
sketch with the Developer, and `to-issues` cuts the PRD into vertical slices,
quizzes the Developer on granularity and dependencies, labels AFK slices
`ready` and HITL slices `needs-human`, and orders them with `depends_on`. The
Developer can say "write the PRD now" to skip the rest of the interview. The
skills live in [`packages/grill-me/skills`](./packages/grill-me/skills) and are
listed by the session OpenCode config's `skills` entry.

## Issues

The `@yaaabk/issues` package owns Issues: the local mirror of the GitHub Issues a
Plan generates. The backend exposes it over HTTP:

| Route | Purpose |
| --- | --- |
| `POST /api/projects/:id/issues` | Create an Issue (`title`, `body`, `label`, `depends_on`, `budget_cents`, `agent_model`) |
| `GET /api/projects/:id/issues` | List a Project's Issues, oldest first |
| `GET /api/projects/:id/issues/:issueId` | Get an Issue |
| `PATCH /api/projects/:id/issues/:issueId` | Update its `title`, `body`, `label`, `status`, `depends_on`, `budget_cents` or `agent_model` |
| `GET /api/projects/:id/issues/:issueId/budget` | The Issue's budget, spend and remainder |
| `DELETE /api/projects/:id/issues/:issueId` | Remove an Issue |
| `GET /api/projects/:id/issues/graph` | The dependency graph, with waves and any cycles |
| `GET /api/projects/:id/issues/sync/status` | How much of the Issue set is mirrored to GitHub |
| `POST /api/projects/:id/issues/sync/push` | Create or update the Project's Issues on GitHub; an optional `planId` scopes it to one Plan |
| `POST /api/projects/:id/issues/sync/pull` | Pull GitHub's open/closed state back onto local Issues |
| `POST /api/projects/:id/issues/sync` | A full push-then-pull cycle |

The browser surface is `/projects/:id/issues/review`: every Plan version with its
lifecycle status (`Not accepted`, `In progress`, `Completed`), accepted date and
closed/total and failed counts, then the selected Plan's summary, full Markdown
and **all** of its Issues including closed ones, grouped by wave. It defaults to
the active Plan; selecting a previous version shows it read-only. When the Plan
has no Issues the page points at the Plan page for the next idea. It offers no
one-shot generation or prompt refinement; changing a Plan or its Issues means
starting another Grill-Me session, and the page links back to the Plan page for
that. Finish is the only endpoint that publishes a Plan or replaces its Issues.

Acceptance is the only step that hands a Plan to GitHub and the agents. It is
available for the active, not yet accepted Plan, and the confirmation modal
explains that accepting records the Plan, creates or updates its Issues on
GitHub and lets agents start on `ready` Issues while `needs-human` Issues wait
for the Developer. Acceptance rejects a Plan with no Issues, a dependency cycle
or an unresolved dependency, and it never relabels anything: the generated
`ready`, `needs-human` and `blocked` labels stay as they are. It pushes only the
selected Plan's Issues and records `acceptedAt` only after that push succeeds; a
failed push leaves the Plan unaccepted and the page offers **Retry accept**. An
accepted Plan with Issues that never reached GitHub gets a small **Retry GitHub
sync** action.

Completion is derived, never stored: a Plan is `Completed` only when it was
accepted, has at least one Issue, and every one of its Issues is closed. The
Plan page's version history shows the same status and links each version to its
review view.

The issue board follows the active Plan too and hides closed Issues by default;
**Show closed** and **Show earlier plans** bring back the history, and an open
Issue from an earlier Plan is called out because the Agent Manager still works
every ready Issue in the Project.

`buildIssueGraph` resolves each Issue's `depends_on` titles to Issue ids, assigns
wave 0 to the Issues with no dependencies and one past their highest dependency
after that, and reports any cycle (or an Issue that transitively depends on one)
with no wave, so the UI can surface it.

The Issue detail shows the budget, what has been spent and what is left, and
lets the Developer edit the budget in dollars. Raising it updates the cap on the
key that is already open as well as the Issue, so the next attempt can use the
new remainder without resetting the attempt counter or reopening a completed
Issue. A spawn or retry the budget cannot afford is refused with the spent,
remaining and required reply amounts and the change to make, rather than
starting a Job OpenRouter would reject.

The module is unit-tested against an in-memory `IssueStore` and the SQLite store
runs against `bun:sqlite`:

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
(any other GitHub error) rather than failing silently. Accepting a Plan pushes
its Issues and records the acceptance only on success; the review page offers a
scoped **Retry GitHub sync** for an accepted Plan with unsynced Issues.

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

`spawn` creates the attempt's working PVC, optional per-attempt credential Secrets, and Job inside the **Project's Namespace** (`yaaabk-<short-uuid>`) mounted at `/work` with a 30-minute deadline, running as the Project's `yaaabk-agent` ServiceAccount with an auto-mounted, auto-rotating ServiceAccount token so the Agent can debug its Project's running workloads with `kubectl` (get/list/watch on pods, services, configmaps, events, deployments, httproutes; read `pods/log`; create `pods/exec`) without any long-lived cluster credential. The spawn flips the Issue to `in_progress`. At most **two** agents
run per Project and **ten** cluster-wide; an attempt that arrives over the limit
is recorded `queued` and dispatched by the reconcile loop as slots free.

The same loop also auto-dispatches the current dependency wave: every Issue
labelled `ready` whose dependencies are all `closed` gets an Agent without a
click, so a Plan proceeds from one wave to the next as pull requests merge.
Issues with any prior run — including a review or a deploy — are left to the
retry and CI paths, as are Issues that are not synced to GitHub, sit on a cycle
or reference a missing dependency. A dispatch refused because the Issue's budget
cannot cover one reply is not retried: the Issue is labelled `needs-human` once,
without spending an attempt, so the Developer can raise the budget or pick a
cheaper model. Other transient dispatch failures are retried after a minute
instead of on every tick.
The loop runs on a timer (`YAAABK_AGENT_POLL_MS`, default 15s) and, on a finished
Job, marks the attempt `success` and records the pull request URL, or marks it
`failed` and either schedules the next attempt or — once `maxAttempts` is reached
— labels the Issue `needs-human`. Each attempt gets its own budgeted OpenRouter
key, minted from the management credential in Settings (or
`OPENROUTER_MANAGEMENT_KEY`) and capped at the Issue's budget; retries and
CI-tracker fix attempts mint one too, so a run never starts without a
credential. GitHub and OpenRouter credentials reach the Job through `envFrom`
Secret references in the Project namespace, so YAAABK never reads their values.

Each attempt's model is resolved when its Job is created: the Issue's
`agentModel`, then the Project's `agentModel`, then `YAAABK_DEFAULT_MODEL`. The
resolved value is recorded on the run, so retries and reviews use it while a
queued run picks up the settings current at dispatch. Changing a model does not
reset the attempt budget or start work. Model writes are validated against the
same live, tool-capable catalogue the Grill-Me page uses; clearing the setting
(`null`) restores inheritance.

Conflict-resolution runs are a separate kind (`resolve-conflicts`): they check
out the pull request branch, merge the base into it and resolve the conflict
markers. They do not consume the Issue's implementation attempts; the CI Tracker
owns their retry budget instead.

Before minting an attempt's key, the resolved model's full reply reservation is
checked against the Issue budget and the account's remaining credits. A run that
cannot afford even one reply is refused with the required amount instead of
dispatching a Job that OpenRouter would reject; free models skip the check, and
an unavailable balance endpoint never blocks a run.

Concurrency is enforced by reserving an attempt's slot synchronously before the
first cluster call, so two racing `spawn`s cannot both claim the last slot. The
module is unit-tested against the in-memory `AgentStore`, a mock cluster and the
real Issues Module; the SQLite store runs against `bun:sqlite`:

```sh
bun run --filter '@yaaabk/agents' test:integration
```

The `@yaaabk/agent` package is what the Job runs: it fetches the Issue, clones
the repository, runs OpenCode with the bundled `implement-issue` skill (which
can inspect and debug the Project's running workloads in its own namespace via
`kubectl` using the mounted `yaaabk-agent` ServiceAccount token), runs the
project's checks, and opens a pull request labelled `automerge`. OpenCode is
invoked with the Agent Manager's configured model and automatic approvals, so a
Job never waits on a permission prompt no human can answer; a missing model or
OpenRouter key fails the run with the setting to configure. The clone →
implement → checks → PR flow is driven through narrow ports, so it is
unit-tested without a cluster, a repository or an LLM; the real adapters shell
out to `git`, OpenCode and the GitHub API.

## CI Tracker

The `@yaaabk/ci-tracker` package closes the agent loop. A background polling loop
(`createCiTracker`, started by the backend on boot) walks every Project, lists
the pull requests labelled `automerge`, and reads the combined check state of
each head commit plus the latest review through the `GitHubPulls` port:

- **green, no review** — a review Agent is spawned to judge the pull request.
- **green, approved** — the pull request is merged, its Issue is closed locally
  and on GitHub, and a deploy Job is spawned as `yaaabk-deploy` to apply the
  manifests, wait for rollout, verify `/health`, and record the deployed commit
  SHA. If the rollout or health check fails, the Job captures the failing pods'
  logs and rolls back to the previous revision when one exists. YAAABK records
  the last deploy status and time on the Project, and labels the Issue
  `deploy-failed`; a failed deploy neither reopens the Issue nor spawns a fix
  Agent, leaving the Developer to decide between code, manifests or the
  rollback.
- **changes requested** — a fix attempt is spawned on the same branch carrying
  the reviewer's summary as a distinct prompt section, until the rejection count
  reaches two or the Issue's attempt budget is spent; then the Issue is labelled
  `needs-human`.
- **failing** — a fix attempt is spawned on the same branch, up to the Issue's
  attempt budget; once the budget is spent the Issue is labelled `needs-human`
  and no further attempts are made.
- **conflicting** — a conflict-resolution Agent checks out the branch, merges
  the default branch into it, reconciles the conflict markers, runs the
  project's checks and force-pushes. CI and review then re-run against the new
  head. Each Issue gets two resolution attempts before `needs-human`, and a
  successful resolution resets that budget.
- **behind but mergeable** — if GitHub refuses a merge because branch protection
  requires an up-to-date head, the tracker asks GitHub to update the branch and
  waits for the new head.
- **pending** — nothing yet; the tracker waits for CI to finish.

Merge-affecting actions are serialized per Project: one merge, branch update or
conflict resolution per pass, because each one moves the base every sibling
branch is compared against. Acting on several at once would otherwise recreate
the conflict it was meant to repair.

The loop policy is extracted into the pure `decideAction` function, so the merge
gate is table-tested across check states, review verdicts, rejection counts and
attempt budgets without a cluster or GitHub. A review verdict is keyed to the
head commit it was made against, so a new push invalidates it and re-triggers a
review while the rejection counter persists. Only Agent-opened pull requests
(those with a linked Issue) are gated; human pull requests merge through
GitHub's normal flow.

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

## Stats

`@yaaabk/stats` turns a Project's Issues and Agent runs into the numbers the
dashboard shows. `computeProjectStats` is pure: the backend fetches the Issues
and runs, then aggregates them in one pass.

| Route | Purpose |
| --- | --- |
| `GET /api/projects/:id/stats` | Issue counts, close velocity, Agent success rate, cost breakdown, run durations and history |
| `GET /api/projects/:id/stats?from=&to=` | The same, with Agent runs and the close timeline filtered to the range |

The browser surface is `/projects/:id/stats`: summary cards, a 7/14/30-day close
chart, a status donut, per-Issue cost bars, run duration by attempt, and a
sortable/filterable run history. The project list also shows each Project's
open/closed counts and last Agent run. Charts are hand-rolled SVG/CSS, so no
chart library is added.

```sh
bun run --filter '@yaaabk/stats' test:unit
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
directory. The backend is built with the `dev` stage, which includes ttyd and
OpenCode so `docker compose` can run local grill sessions; set
`OPENROUTER_MANAGEMENT_KEY` in the environment (or `.env`) so each session can
mint its own budgeted key.

## CI

`.github/workflows/ci.yml` runs on every push to `main` and on pull requests:
format check, lint, typecheck, unit tests, build, and end-to-end tests.
