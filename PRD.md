# PRD: YAAABK — Yet Another AI App Builder for Kubernetes

## Problem Statement

Building and deploying applications on Kubernetes requires navigating a fragmented toolchain: GitHub for code, ArgoCD for GitOps, a CI system for testing, and an LLM provider for AI assistance. Developers spend more time stitching these together than building their actual product. Beginners find the learning curve insurmountable; experts waste time on repetitive boilerplate.

YAAABK solves this by providing a single browser-based platform that takes a developer from a raw idea to a deployed application on Kubernetes — automatically generating plans, issues, code, and deployments through AI-driven workflows.

## Solution

YAAABK is an AI-native Internal Developer Platform that a Platform Admin installs on a Kubernetes cluster. A Developer creates a Project, brainstorms their idea in an interactive grill-me session powered by OpenCode, reviews and refines AI-generated issues, and lets autonomous Agents implement each issue — creating PRs, running CI, and deploying via ArgoCD — all from the browser.

## User Stories

1. As a **Platform Admin**, I want to install YAAABK on my Kubernetes cluster with minimal configuration, so that my team can start using it quickly.

2. As a **Platform Admin**, I want to configure cluster-level security policies (Kyverno, PSA) for project namespaces, so that agent workloads are isolated and secure by default.

3. As a **Developer**, I want to log into YAAABK with a username, password, and two-factor authentication, so that my account is secure.

4. As a **Developer**, I want to configure my GitHub OAuth token and OpenRouter API key in settings, so that YAAABK can create repos and run AI agents on my behalf.

5. As a **Developer**, I want to create a Project by providing a name and description, so that YAAABK bootstraps a GitHub repo, K8s namespace, and ArgoCD Application automatically.

6. As a **Developer**, I want to set my skill level to beginner or expert, so that the grill-me session asks questions at the right depth for my experience.

7. As a **Developer**, I want to start a grill-me session with my raw idea, so that the AI asks me questions and helps me refine it into a concrete plan.

8. As a **Developer**, I want to see the AI's questions streamed live in my browser, so that I can respond in real time without page refreshes.

9. As a **Developer**, I want to answer the AI's questions and receive follow-up questions, so that the plan is iteratively refined until complete.

10. As a **Developer**, I want to see the finalized Plan as a markdown document in the UI, so that I can review what was agreed upon.

11. As a **Developer**, I want to review AI-generated Issues before they're created, so that I can adjust titles, descriptions, or dependencies via further prompting.

12. As a **Developer**, I want to have the refined set of issues re-evaluated by the AI based on my feedback, so that the final issue list accurately reflects my intent.

13. As a **Developer**, I want to approve the issue list and have it created as GitHub Issues automatically, so that I don't need to switch contexts.

14. As a **Developer**, I want to see a kanban-style issue board showing each issue's status, label, and dependency graph, so that I can track progress at a glance.

15. As a **Developer**, I want issues with no dependencies to be implemented in parallel (up to 2 concurrent agents), so that the project completes faster.

16. As a **Developer**, I want blocked issues to automatically start once their dependencies are completed, so that the pipeline flows without manual intervention.

17. As a **Developer**, I want each agent to create a branch, implement the feature, run pre-commit hooks, commit, push, open a PR with an automerge label, and report back — all autonomously.

18. As a **Developer**, I want agents to persist their work state to a PVC, so that work is not lost if a pod is killed or times out.

19. As a **Developer**, I want CI failures to automatically trigger a fix agent (up to 3 attempts per issue), so that I don't have to manually investigate and fix every pipeline break.

20. As a **Developer**, I want each agent run to have a configurable budget limit (default $0.50), so that runaway LLM costs are prevented.

21. As a **Developer**, I want to see a dashboard with project stats (open/closed issues, agent success rate, cost tracking), so that I can monitor project health.

22. As a **Developer**, I want to export my project to my own GitHub account on request, so that I'm not locked into the platform.

23. As a **Platform Admin**, I want to configure rate limits and concurrency caps per project and cluster-wide, so that resource usage is controlled.

## Implementation Decisions

### Modules

The system is composed of 10 modules, each with a clear boundary and testable interface:

1. **Auth Module** — Encapsulates all authentication concerns: first-run setup, login, 2FA verification, session management, and logout. Exposes a simple API to check if the user is authenticated and to retrieve the current user. Uses SQLite as the user store, `otplib` for TOTP generation/verification, and `jose` for JWT signing.

2. **Projects Module** — Orchestrates project creation and lifecycle. On creation, it calls the Template Module to scaffold the repo, the K8s Client Module to create the namespace and RBAC, and a GitHub client to create the repo. Exposes CRUD operations for projects.

3. **Plans Module** — Manages plan documents. Stores markdown content with version numbering in SQLite. Supports creating a new version, retrieving the active version, and listing version history.

4. **Grill-Me Module** — The most novel module. Manages the lifecycle of an OpenCode sidecar process: spawns it with the YAAABK-specific grill-me skill loaded, pipes stdin/stdout, parses structured markers (`<QUESTION>`, `<PLAN>`, `<ISSUES>`), and streams output to the browser via SSE. The module's interface is event-driven: it emits events like `question`, `plan_ready`, `issues_generated`, and accepts commands like `answer` and `refine_issues`.

5. **Issues Module** — Manages the local issue database and syncs with GitHub Issues. Builds a dependency graph from the `depends_on` field in each issue, computes waves of parallel-executable issues, and exposes this graph to the Agent Manager. Supports CRUD and status transitions.

6. **Agent Manager Module** — Owns the lifecycle of agent K8s Jobs. Accepts a list of ready issues, respects concurrency limits (2 per project, 10 cluster-wide), creates Jobs with PVC attachments, monitors their status, and handles retries. Uses the K8s Client Module for all cluster interactions.

7. **CI Tracker Module** — A background polling loop that queries GitHub check suites for open PRs labeled `automerge`. On detecting a failure, notifies the Agent Manager to spawn a fix agent (up to 3 attempts). On detecting success, triggers the merge and updates the issue status.

8. **Cost Control Module** — Integrates with the OpenRouter Management API to create per-issue API keys with configurable budget limits and reset intervals. Tracks spend per issue and reports remaining budget.

9. **Template Module** — Manages the `yaaabk/template-svelte-bun` repository. Clones it, interpolates project-specific values (name, repo URL, port, etc.), and pushes the result to a new GitHub repo. Exposes a single `scaffold(project)` function.

10. **K8s Client Module** — A thin wrapper around `@kubernetes/client-node` that exposes only the operations YAAABK needs: create/delete Namespace, create/delete Secret, create/delete ServiceAccount + RoleBinding, create/delete Job, watch Job status. All operations are scoped to the specific needs of YAAABK and are testable with a mock K8s API.

### Architectural Decisions

| Decision | Choice | Rationale |
|---|---|---|
| OpenCode integration | Sidecar container in YAAABK pod | Simpler than per-session Jobs; YAAABK manages process lifecycle directly |
| Skill output format | Structured markers (`<QUESTION>`, `<PLAN>`, `<ISSUES>`) | Reliable parsing without LLM post-processing |
| Issue generation | Part of the grill-me skill output | Single context, consistent output, no extra LLM calls |
| Agent runtime | OpenCode-based with YAAABK `implement-issue` skill | Reuses OpenCode's tooling instead of building from scratch |
| GitHub identity | YAAABK's own GitHub account | Simplifies Developer onboarding — no GitHub account needed |
| GitHub auth | OAuth App configured by Platform Admin | Standard, secure, supports token refresh |
| YAAABK auth | Username + password + required TOTP 2FA | Self-contained, no external dependencies, secure for public deployment |
| Database | SQLite (via better-sqlite3 or libsql) | Single file, zero ops, sufficient for single-user instance. Doubles as session/cache store |
| CI detection | Polling (every 30s) | Works behind NAT/firewall, no public endpoint needed |
| Template source | Separate GitHub repo | Versioned independently, can be forked by Developers |
| ArgoCD integration | K8s CRD (Application resource) | YAAABK already has K8s API access; no separate auth needed |
| Work persistence | PVC on agent pods | Prevents work loss on timeout or pod restart |

### Schema

SQLite schema with these tables:

- **users** — id, username, password_hash, totp_secret, totp_verified, created_at
- **projects** — id (uuid), name, description, github_repo_url, k8s_namespace, argo_app_name, skill_level, created_at, updated_at
- **plans** — id (uuid), project_id (FK), version, content_markdown, skill_level, source, created_at, is_active
- **issues** — id (uuid), project_id (FK), plan_id (FK nullable), github_number, title, body, status, label, depends_on (JSON array of issue titles), attempt_count, max_attempts, budget_cents, openrouter_key_hash, closed_at, created_at
- **agent_runs** — id (uuid), issue_id (FK), attempt_number, k8s_job_name, status, pr_url, logs, cost_cents, started_at, finished_at
- **sessions** — id, user_id (FK), token_hash, expires_at

## Testing Decisions

### Testing Philosophy

Tests should verify external behavior, not implementation details. A module's public API is its contract — test that the contract is upheld, not how it's implemented internally. For example, the Grill-Me module should be tested by sending input and asserting output events, not by inspecting internal process state.

### Modules to Test

All 10 modules will have unit tests. Integration tests will cover the key boundaries:

- **Auth Module** — Test login flow (correct/wrong password, missing 2FA, expired session), first-run setup, TOTP verification. Use an in-memory SQLite database.
- **Projects Module** — Test project creation end-to-end with mock GitHub API and mock K8s API. Test error handling when repo creation fails, namespace already exists, etc.
- **Plans Module** — Test CRUD operations, versioning, activation/deactivation of plan versions.
- **Grill-Me Module** — Test with a mock OpenCode process that outputs known structured markers. Verify correct event emission for questions, plan output, and issue generation. Test timeout and error scenarios.
- **Issues Module** — Test dependency graph construction, wave computation, status transitions. Test GitHub sync with mock Octokit.
- **Agent Manager Module** — Test concurrency limiting (max 2 per project), queue ordering, attempt tracking, PVC creation. Use mock K8s client.
- **CI Tracker Module** — Test polling loop with mock GitHub API, verify fix agent triggering on failure, verify max attempt enforcement.
- **Cost Control Module** — Test key creation, budget enforcement, spend tracking with mock OpenRouter API.
- **Template Module** — Test scaffolding with a mock template repo, verify interpolation of project values.
- **K8s Client Module** — Test with a mock K8s API server (or kind for integration tests). Verify namespace creation, secret creation, job lifecycle.

### Prior Art

Tests should follow patterns established in the SvelteKit + Bun testing ecosystem: Vitest for unit tests, Playwright for E2E browser tests, and mock implementations for external dependencies (GitHub, OpenRouter, K8s API).

## Out of Scope

- Multi-tenant / multi-user support per instance — each YAAABK instance has one Developer
- GitLab or other Git provider support — GitHub only for MVP
- Custom templates beyond Svelte+Bun — template customization deferred
- Preview environments (per-PR deployments) — deferred to post-MVP
- Notifications (Slack, email) — deferred to post-MVP
- Billing dashboard — deferred to post-MVP
- Admin panel for cluster-wide management — deferred to post-MVP
- Mobile app or PWA — browser-only for MVP
- Custom LLM provider support beyond OpenRouter — deferred
- Agent training/fine-tuning — agents use pre-trained models via OpenRouter

## Further Notes

- The Template module expects the template repo at `github.com/yaaabk/template-svelte-bun` to be created before Phase 1 implementation begins.
- The GitHub OAuth App must be registered by the Platform Admin before the Developer can connect their account. The callback URL should point to the YAAABK instance.
- PVC storage class should be configurable via environment variables; default to the cluster's default storage class.
- OpenRouter Management API key is configured by the Developer in Settings. It is used solely to create per-issue sub-keys and is never used for inference calls.
- Agent logs are stored in the `agent_runs.logs` column as text. For long-running agents, logs are streamed to the UI via the agent pod's stdout. Historical logs are retained for 30 days (configurable).

### Issue Wave Scheduling Algorithm

The Agent Manager uses a wave-based scheduling algorithm to maximize parallel execution while respecting dependencies:

1. **Build dependency graph** — Each Issue's `depends_on` field references other issue titles. The Agent Manager resolves these into a directed acyclic graph (DAG) of issue IDs.

2. **Compute waves** — Wave 0 contains all issues with no dependencies. Wave N contains issues whose dependencies are all in waves 0 through N-1. Issues within the same wave have no transitive dependencies on each other.

3. **Schedule by wave** — All issues in wave 0 are eligible for immediate execution (up to concurrency limits). When an issue completes (success or failure), its dependents are re-evaluated: if all dependencies are resolved, the dependent becomes eligible for the next scheduling cycle.

4. **Concurrency gates** — At most 2 agents run per project simultaneously, and at most 10 cluster-wide. Eligible issues beyond these limits are queued and scheduled as running agents complete.

5. **Failure handling** — If an issue fails after 3 attempts, its dependents are blocked. The dependents' status transitions to `blocked` with a note referencing the failed dependency. The Developer must manually unblock (either fix or remove the dependency).

This algorithm is validated against YAAABK's own implementation plan: the 15 vertical slices above form a real dependency DAG that the YAAABK team can use to verify the Agent Manager's behavior during development (dogfooding).
