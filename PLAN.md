# YAAABK — Plan

## Yet Another AI App Builder for Kubernetes

**Elevator Pitch**: An AI-native Internal Developer Platform that takes you from idea to deployed application on Kubernetes. Grill your idea in an interactive terminal session that produces a PRD-shaped Plan and vertical-slice Issues, then let autonomous agents implement those Issues — all from a browser.

---

## Table of Contents

1. [Core Concepts](#1-core-concepts)
2. [Architecture Overview](#2-architecture-overview)
3. [Component Breakdown](#3-component-breakdown)
4. [Data Model](#4-data-model)
5. [User Flows](#5-user-flows)
6. [Security Model](#6-security-model)
7. [Cost Control](#7-cost-control)
8. [Phased Implementation Plan](#8-phased-implementation-plan)
9. [Open Questions](#9-open-questions)

---

## 1. Core Concepts

### What YAAABK Does

| Step | What Happens |
|---|---|
| 1. Create Project | User provides name + description. YAAABK creates a GitHub repo, bootstraps it from a Svelte+Bun template, and provisions a Namespace, RBAC and deploy pipeline. |
| 2. Grill and Plan | User enters a Grill-Me Session: a real terminal running `opencode mini` behind ttyd, either locally or in a hardened per-session Pod. Project mode (guided/autonomous) controls how the agent works. |
| 3. Publish Plan and Issues | The agent interviews, synthesises a PRD, and cuts it into vertical-slice Issues. Finish publishes them together as one Plan version labelled “Plan (PRD)” and replaces that Plan’s Issues. |
| 4. Triage Issues | Issues are labeled `ready`, `refinement-needed`, `blocked` or `needs-human`. |
| 5. Spawn Agents | `ready` issues get an autonomous K8s Job that implements the feature, creates a PR, and auto-merges after CI passes. |
| 6. Auto-Fix | If CI fails, a new agent is spawned to fix the issue (max 3 attempts per issue). |
| 7. Deploy | A merged change triggers the agent-driven Deploy Job. |

### Guiding Principles

- **Secure by default** — least-privilege for agents and sessions, PSA/Kyverno policies, per-Project RBAC.
- **Cost-controlled** — per-issue OpenRouter budgets prevent runaway spend.
- **Human in the loop only when needed** — refinement feedback, manual intervention after 3 failures.
- **Kubernetes-native** — everything runs on K8s, uses CRDs, Jobs, and RBAC.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         Browser (Svelte UI)                     │
│  Project Dashboard │ Plan terminal │ Issue Board │ Stats        │
└──────────────────────┬──────────────────────────────────────────┘
                       │ HTTP + terminal WebSocket
                       ▼
┌──────────────────────────────────────────────────────────────────┐
│                    YAAABK Backend (Bun + Hono)                   │
│                                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────────┐  │
│  │ Projects │  │  Auth    │  │  Issues  │  │ Agent Manager  │  │
│  │  API     │  │          │  │  API     │  │                │  │
│  └──────────┘  └──────────┘  └──────────┘  └────────────────┘  │
│                                                                  │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────────┐  │
│  │ Grill sessions │  │ GitHub         │  │ Cost Control       │  │
│  │ + terminal     │  │ Client         │  │ (OpenRouter keys)  │  │
│  │ proxy          │  │                │  │                    │  │
│  └────────────────┘  └────────────────┘  └────────────────────┘  │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  SQLite: projects, plans, issues, agents, grill sessions  │  │
│  └───────────────────────────────────────────────────────────┘  │
└──────────────────────┬───────────────────────────────────────────┘
                       │
┌──────────────────────────────────────────────────────────────────┐
│                   Kubernetes Cluster                             │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Namespace: yaaabk                                        │  │
│  │  ┌────────────┐ ┌──────────────────────┐                 │  │
│  │  │ YAAABK     │ │ Kyverno / PSA        │                 │  │
│  │  │ Deployment │ │ Admission Controller │                 │  │
│  │  └────────────┘ └──────────────────────┘                 │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Namespace: yaaabk-<short-uuid> (one per Project)         │  │
│  │  ┌────────────┐ ┌──────────────┐ ┌──────────────────┐   │  │
│  │  │ User App   │ │ Agent Jobs   │ │ Session Pod      │   │  │
│  │  │ Deployment │ │ (per issue)  │ │ (ttyd+OpenCode)  │   │  │
│  │  └────────────┘ └──────────────┘ └──────────────────┘   │  │
│  └───────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### Key Communication Flows

1. **UI ↔ Backend**: REST API (Hono) plus a WebSocket the backend proxies to a session's ttyd
2. **Backend ↔ Session runtime**: start, stop and inspect a per-session Pod (or local ttyd/OpenCode child processes)
3. **Browser ↔ terminal**: xterm.js input/resize frames translated to ttyd `tty` frames by the backend proxy
4. **Session agent ↔ Backend**: typed `report_prd`, `report_issues` and `session_status` MCP tools authenticated by the session bearer token
5. **Backend ↔ GitHub**: repo creation, issue management, pull requests and reviews
6. **Backend ↔ K8s API**: create Project namespaces/RBAC plus Agent Jobs, session Pods and NetworkPolicies
7. **Agent ↔ GitHub**: clone repo, create branches, push commits, open PRs
8. **Agent ↔ OpenRouter**: LLM calls with a per-issue or per-session budgeted key

---

## 3. Component Breakdown

### 3.1 Frontend (Svelte + Bun)

**Framework**: SvelteKit (because Svelte is the template target — eat your own dogfood)
**CSS**: Tailwind CSS
**Terminal**: xterm.js in the Plan page, connecting over a WebSocket the backend proxies to the session's ttyd; no chat UI or SSE stream

**Pages**:
| Route | Purpose |
|---|---|
| `/` | Landing / project list |
| `/projects/new` | Create project wizard |
| `/projects/:id` | Project dashboard (stats, open/closed issues) |
| `/projects/:id/plan` | Start form, live terminal, then the published Plan (PRD) and Issues |
| `/projects/:id/issues` | Issue board (kanban-ish) |
| `/projects/:id/issues/review` | Review published Issues; links back to a new Grill-Me session |
| `/settings` | GitHub connection, preferences |

### 3.2 Backend (Bun + Hono)

**Runtime**: Bun (fast startup, TypeScript native)
**Framework**: Hono (lightweight, fast, K8s-friendly)
**Database**: SQLite (Turso/libsql or better-sqlite3/bun:sqlite), a single file with no separate service
**Session Store**: the same SQLite file; live terminal state stays in the session runtime

**API Modules**:

| Module | Endpoints | Purpose |
|---|---|---|
| Auth | `/api/auth/*` | First-run setup, login, 2FA, logout |
| Projects | `CRUD /api/projects` | Project lifecycle + bootstrap |
| Plans | `CRUD /api/projects/:id/plans` | Manage versioned Plan documents |
| Grill sessions | `POST|GET /api/projects/:id/grill`, `.../finish`, `.../cancel`, `.../terminal` | Start, inspect, finish, cancel and stream a terminal session |
| Grill reports | `POST /api/grill-sessions/:id/report`, `GET .../status` | Typed drafts from the session MCP server (bearer token) |
| Issues | `CRUD /api/projects/:id/issues` | Issue management, dependency graph and GitHub sync |
| Agents | `POST /api/projects/:id/issues/:id/spawn` | Trigger agent Jobs |
| Stats | `GET /api/projects/:id/stats` | Open/closed counts, velocity |

### 3.3 Grill-Me terminal sessions

The Grill-Me Session is a real interactive terminal, not a chat. YAAABK needs to:

1. **Start a session runtime**: a hardened Pod in the Project Namespace when deployed, or ttyd + `opencode mini` child processes for local development, both behind the same `SessionRuntime` port
2. **Proxy the terminal**: authenticate the browser WebSocket, connect to ttyd with the `tty` subprotocol, translate input and resize frames, and translate output, title and preference frames back
3. **Give the agent context**: clone the Project repository with a short-lived `contents:read` GitHub App token, then remove the credential from the remote; expose read-only workload inspection plus `pods/exec`, and never Secrets
4. **Take typed reports, not parsed stdout**: the image's stdio MCP server exposes `report_prd`, `report_issues` and `session_status`; reports become drafts on the session
5. **Publish once**: Finish creates one Plan version labelled “Plan (PRD)” and replaces that Plan's Issues. Cancel discards the drafts

Sessions are reaped after 30 minutes of inactivity and hard-capped at four hours. One session is active per Project; starting another replaces the previous one. A browser refresh reconnects to the same runtime, and a backend restart reconciles live, missing and orphaned runtimes.

### 3.4 Agent System

**Per-Issue K8s Job**:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: agent-issue-<id>
  namespace: yaaabk-<short-uuid>
spec:
  template:
    spec:
      serviceAccountName: yaaabk-agent
      containers:
      - name: agent
        image: yaaabk/agent:latest
        env:
        - name: GITHUB_TOKEN
          valueFrom:
            secretKeyRef: ...  # project-scoped token
        - name: OPENROUTER_API_KEY
          valueFrom:
            secretKeyRef: ...  # per-issue key with budget
        - name: ISSUE_NUMBER
          value: "42"
        - name: MAX_ATTEMPTS
          value: "3"
        - name: REPO_URL
          value: "https://github.com/..."
      restartPolicy: Never
  backoffLimit: 1
```

**What the Agent Does**:
1. Fetches the issue details from GitHub
2. Clones the repo
3. Analyzes the codebase and issue description
4. Proposes changes (with LLM guidance via OpenRouter)
5. Runs pre-commit hooks (lint, type-check, test)
6. Creates a branch + PR with `automerge` label
7. Reports status back to YAAABK API
8. If CI fails → exits non-zero → YAAABK spawns a new attempt (max 3)

**Agent Image** (`yaaabk/agent`):
- Based on `oven/bun` (small, fast)
- Contains: `git`, GitHub CLI, pre-commit hooks config
- Runs a TypeScript script that uses Octokit + OpenRouter SDK

### 3.5 Template System

**Bootstrap script** that creates a new repo with:
- SvelteKit frontend
- Bun backend (Hono or Elysia)
- Dockerfile + K8s manifests
- GitHub Actions workflow (CI: type-check, test, build, push image, update manifest)
- Deploy Job manifest in `/deploy/` directory
- Pre-commit hooks config (lint, type-check, test)

**Template repo**: `yaaabk/template-svelte-bun` (or embedded in YAAABK as a scaffolding script)

---

## 4. Data Model

```
Project
├── id: uuid
├── name: string
├── description: string
├── github_repo_url: string
├── k8s_namespace: string (yaaabk-<short-uuid>)
├── mode: "autonomous" | "guided"
├── last_grill_model: string (nullable)
├── deployed_commit_sha: string (nullable)
├── last_deploy_status: string (nullable)
├── created_at: timestamp
├── updated_at: timestamp
│
├── Plan
│   ├── id: uuid
│   ├── project_id: uuid FK
│   ├── version: int
│   ├── content_markdown: text
│   ├── mode: string
│   ├── source: "grill-me" | "upload"
│   ├── created_at: timestamp
│   └── is_active: boolean
│
├── Issue
│   ├── id: uuid
│   ├── project_id: uuid FK
│   ├── plan_id: uuid FK (nullable)
│   ├── github_number: int
│   ├── title: string
│   ├── body: text
│   ├── status: "open" | "in_progress" | "closed" | "failed"
│   ├── label: "ready" | "refinement-needed" | "blocked" | "needs-human"
│   ├── attempt_count: int (default 0)
│   ├── max_attempts: int (default 3)
│   ├── budget_cents: int (default configurable)
│   ├── openrouter_key_id: string (nullable)
│   ├── closed_at: timestamp (nullable)
│   └── created_at: timestamp
│
├── GrillSession
│   ├── id: uuid
│   ├── project_id: uuid FK
│   ├── status: "starting" | "active" | "finishing" | "finished" | "cancelled" | "failed"
│   ├── mode: "autonomous" | "guided"
│   ├── model: string
│   ├── runtime_ref: (provider, handle, terminal URL)
│   ├── report_token_hash: string
│   ├── openrouter_key_hash: string
│   ├── draft_prd: text (nullable)
│   ├── draft_issues: JSON (nullable)
│   ├── plan_id: uuid FK (nullable, set by Finish)
│   ├── last_activity_at: timestamp
│   ├── started_at: timestamp
│   ├── ended_at: timestamp (nullable)
│   └── end_reason: "finished" | "cancelled" | "replaced" | "failed" | "timeout" (nullable)
│
├── AgentRun
│   ├── id: uuid
│   ├── issue_id: uuid FK
│   ├── attempt_number: int
│   ├── k8s_job_name: string
│   ├── status: "pending" | "running" | "success" | "failed"
│   ├── pr_url: string (nullable)
│   ├── logs_s3_path: string (nullable)
│   ├── cost_cents: int
│   ├── started_at: timestamp
│   └── finished_at: timestamp (nullable)

User / Auth (future: multi-tenant)
├── id: uuid
├── github_id: int
├── github_login: string
├── avatar_url: string
└── created_at: timestamp
```

---

## 5. User Flows

### 5.1 Project Creation Flow

```
[User]                    [YAAABK]                    [GitHub]                    [K8s]
  │                          │                          │                          │
  │── POST /projects ───────►│                          │                          │
  │  {name, desc, level}     │                          │                          │
  │                          │── POST /repos ──────────►│                          │
  │                          │◄── repo_url ─────────────│                          │
  │                          │                          │                          │
  │                          │── Push template ────────►│                          │
  │                          │                          │                          │
  │                          │── Create namespace ──────│─────────────────────────►│
  │                          │── Create SA + RBAC ──────│─────────────────────────►│
  │                          │                          │                          │
  │                          │── Trigger Deploy Job ────│─────────────────────────►│
  │                          │◄── deployed commit ──────│──────────────────────────│
  │◄── 201 Created ──────────│                          │                          │
  │  {project, repo, ns}     │                          │                          │
```

### 5.2 Plan Refinement Flow (Grill-Me)

```
[User Browser]              [YAAABK Backend]              [Session Pod]
     │                            │                            │
     │── POST /grill ────────────►│── start runtime ──────────►│
     │  {idea, model}             │  (clone repo, mint key)    │
     │◄── 201 {session} ──────────│◄── Pod + ttyd ready ───────│
     │                            │                            │
     │── GET .../terminal (WS) ──►│── ttyd WebSocket ─────────►│
     │── input / resize ─────────►│── tty frames ─────────────►│
     │◄── output / title ─────────│◄── agent output ───────────│
     │                            │                            │
     │                            │◄── report_prd (MCP) ───────│
     │                            │◄── report_issues (MCP) ────│
     │                            │    (stored as drafts)      │
     │                            │                            │
     │── POST .../finish ────────►│── publish Plan (PRD) + Issues
     │◄── {plan, issues} ─────────│    then stop the runtime   │
```

### 5.3 Agent Implementation Flow

```
[YAAABK]                 [K8s]                   [Agent Pod]           [GitHub]            [Deploy Job]
   │                       │                        │                    │                   │
   │── Create Job ────────►│                        │                    │                   │
   │                       │── Start Pod ──────────►│                    │                   │
   │                       │                        │── Fetch issue ────►│                   │
   │                       │                        │◄── issue body ─────│                   │
   │                       │                        │                    │                   │
   │                       │                        │── Clone repo ─────►│                   │
   │                       │                        │◄── repo ───────────│                   │
   │                       │                        │                    │                   │
   │                       │                        │── Analyze + code ──│                   │
   │                       │                        │── Run pre-commit ◄─│ (lint + test)     │
   │                       │                        │                    │                   │
   │                       │                        │── Create PR ──────►│                   │
   │                       │                        │── Label automerge ►│                   │
   │                       │                        │◄── PR #42 ─────────│                   │
   │                       │                        │                    │                   │
   │                       │                        │── Report success ─►│                   │
   │                       │                        │                    │                   │
   │◄── Job succeeded ─────│                        │                    │                   │
   │                       │                        │                    │                   │
   │── Wait for CI ────────│────────────────────────│───────────────────►│                   │
   │                       │                        │                    │◄── PR merged ─────│
   │                       │                        │                    │                   │
   │── Deploy merged ──────│────────────────────────│───────────────────►│                   │
   │                       │                        │                    │                   │
   │── Update issue ───────│                        │                    │                   │
   │   status=closed       │                        │                    │                   │
```

### 5.4 Auto-Fix Flow (Pipeline Failure)

```
[GitHub Actions]         [YAAABK]                 [K8s]                  [Agent Pod]
     │                       │                       │                       │
     │◄── CI check fails ────│                       │                       │
     │  (polled)             │                       │                       │
     │                       │── Increment attempt   │                       │
     │                       │── Check ≤ 3 attempts  │                       │
     │                       │── Create new Job ────►│                       │
     │                       │                       │── Start fix-agent ───►│
     │                       │                       │                       │── Clone PR branch
     │                       │                       │                       │── Fix issue
     │                       │                       │                       │── Force push
     │                       │                       │                       │── Re-run CI
     │◄── CI passes ─────────│───────────────────────│───────────────────────│
     │── Auto-merge ─────────►                       │                       │
     │                       │                       │                       │
     │                       │── Update issue        │                       │
     │                       │   status=closed       │                       │
     │                       │                       │                       │
     │                       │  (if all 3 fail:      │                       │
     │                       │   label=needs-human)  │                       │
```

---

## 6. Security Model

### 6.1 Principle of Least Privilege

```
┌─────────────────────────────────────────────────────────────────┐
│  Cluster Level                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ yaaabk namespace                                          │   │
│  │ ● YAAABK app SA:                                          │   │
│  │   - Creates Namespaces, RBAC, Jobs, Pods and              │   │
│  │     NetworkPolicies inside Project Namespaces             │   │
│  │   - No Secret reads in Project Namespaces                 │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ yaaabk-<short-uuid> namespace                             │   │
│  │ ● yaaabk-agent SA (Agent Jobs and Session Pods):          │   │
│  │   - Read-only workloads + logs, plus pods/exec             │   │
│  │   - NO Secret reads, NO cluster access                    │   │
│  │   - Short-lived GitHub token and budgeted OpenRouter key  │   │
│  │ ● User App SA:                                            │   │
│  │   - No K8s API access at all                              │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### 6.2 Kyverno / PSA Policies

Apply to all `project-*` namespaces:

| Policy | Enforcement |
|---|---|
| Deny privileged containers | Must run as non-root |
| Deny host network access | No hostNetwork |
| Deny hostPath volumes | No hostPath |
| Require readOnlyRootFilesystem | Yes for app containers |
| Deny latest image tag | Must use explicit version |
| Limit resource ranges | CPU/memory limits required |
| Deny cluster-admin binding | No ClusterRoleBinding |

### 6.3 Session Pod Restrictions

Each Grill-Me Session runs in its own Pod in the Project Namespace:

- **Identity**: the Project's `yaaabk-agent` ServiceAccount
- **Pod Security**: `restricted` (non-root, no privilege escalation, all capabilities dropped, default seccomp, explicit CPU/memory limits)
- **Network**: ingress only from the backend proxy; egress only to the backend, the Kubernetes API, GitHub, OpenRouter and DNS
- **Cluster access**: read-only pods, logs, deployments, services, configmaps, events and HTTPRoutes, plus `pods/exec`; no Secret reads and no mutations
- **Credentials**: a budget-limited OpenRouter key and a per-session report token, both revoked when the session ends; the clone token lives only in the init container

### 6.4 GitHub Token Scoping

| Token | Scope | Used By |
|---|---|---|
| GitHub App Installation Token | Contents: write, Pull Requests: write, Issues: write, Metadata: read | YAAABK backend / Agent Jobs |
| Session clone token | Contents: read | Grill-Me Session init container (removed after cloning) |

---

## 7. Cost Control

### 7.1 Per-Issue and Per-Session OpenRouter Budget

**Mechanism**: Create a limited, expiring API key via OpenRouter's API for each Issue and each Grill-Me Session.

```
┌──────────────────────────────────────────────────┐
│ Issue Budget Configuration                       │
│                                                  │
│ Default: $1.00 per issue                         │
│ User can override when creating issue            │
│ Max: $5.00 per issue (system limit)              │
│                                                  │
│ Budget covers: LLM calls for the Issue's agents  │
│ or the session's grilling. A session key is also │
│ short-lived and revoked when the session ends.   │
│ If budget is exhausted → the run stops           │
└──────────────────────────────────────────────────┘
```

### 7.2 Attempt Cost Tracking

| Attempt | What Happens | Cost Implication |
|---|---|---|
| 1 | Full implementation | Full budget consumed |
| 2 | Fix pipeline failure | Additional LLM calls, from same budget |
| 3 | Second fix attempt | Remaining budget |
| After 3 | Human intervention | No more auto-spend |

### 7.3 Agent Resource Limits

```yaml
resources:
  requests:
    cpu: "500m"
    memory: "512Mi"
  limits:
    cpu: "1"
    memory: "1Gi"
```

### 7.4 Concurrency Limits

- Max 2 concurrent agents per project (configurable)
- Max 10 concurrent agents cluster-wide
- Queue management in YAAABK backend

---

## 8. Phased Implementation Plan

### Phase 0: Foundation (Week 1-2)

- [x] Create project repo (`yaaabk`)
- [x] Set up monorepo structure (frontend + backend + agent + templates)
- [x] Set up CI/CD for YAAABK itself
- [ ] Set up development environment (local K8s via kind/minikube)
- [x] Use a single SQLite file for state (no PostgreSQL or Redis)

### Phase 1: Core Platform (Week 3-5)

- [ ] **Auth**: GitHub OAuth login
- [ ] **Projects API**: CRUD + GitHub repo creation via GitHub App
- [ ] **Template system**: Scaffold Svelte+Bun repos from template
- [x] **Deploy path**: agent-driven Deploy Job replaces ArgoCD
- [x] **Namespace provisioning**: Create the `yaaabk-<short-uuid>` namespace with RBAC and policies
- [ ] **Basic UI**: Project list, create project wizard, project dashboard

### Phase 2: Plan & Issues (Week 6-8)

- [x] **Session runtime**: Per-session Pods in Kubernetes, local ttyd + OpenCode for development
- [x] **Grill-Me Session UI**: xterm.js terminal behind the backend proxy, with reconnect and resize
- [x] **Project mode vocabulary**: Guided and autonomous modes in the image-baked skills
- [x] **PRD handoff**: `grill-me` → `to-prd` → `to-issues` with typed draft reports
- [x] **Publishing**: Finish creates one Plan (PRD) and replaces that Plan's Issues
- [ ] **Issue board UI**: Kanban view, labels, status filtering
- [ ] **Stats dashboard**: Open/closed counts, attempt tracking

### Phase 3: Agents (Week 9-12)

- [ ] **Agent image**: Docker image with bun + git + gh CLI + Octokit
- [ ] **Per-issue Job creation**: Agent Manager module in backend
- [ ] **ServiceAccount + RBAC per project**: Agent can only access its namespace
- [ ] **PR creation workflow**: Branch → commit → push → PR → automerge label
- [ ] **CI tracking**: Webhook receiver for GitHub Actions status
- [ ] **Auto-fix**: Spawn retry agent on CI failure (max 3)
- [ ] **Cost control**: OpenRouter per-issue key creation + budget enforcement
- [ ] **Agent logs**: Capture and display in UI

### Phase 4: Hardening (Week 13-14)

- [ ] **Kyverno policies**: Apply to all project namespaces
- [ ] **PSA enforcement**: Pod Security Admission
- [ ] **Session Pod hardening audit**: Verify the NetworkPolicy, Pod Security and OpenCode deny-list in a live cluster
- [ ] **Error handling**: Dead letter queues, notifications (internal)
- [ ] **Rate limiting**: Prevent abuse of agent spawning
- [ ] **Monitoring**: Metrics for agent success rate, cost, latency

### Phase 5: Polish & Extend (Week 15+)

- [ ] **Notifications** (Slack/email) for issue completion or failure
- [ ] **GitLab support**
- [ ] **Custom templates** (not just Svelte+Bun)
- [ ] **Preview environments** (per-PR deployments)
- [ ] **Billing dashboard** for project costs
- [ ] **Admin panel** for cluster-wide management

---

## 9. Open Questions

These need decisions before/during implementation:

### Architecture
1. **OpenCode integration**: ~~Sidecar in the YAAABK pod, or per-session K8s Job?~~ Resolved: a hardened per-session Pod in the Project Namespace, with a local ttyd/OpenCode adapter for development.
2. **Template source**: Separate GitHub template repo, or embedded in YAAABK image? (Recommend: separate repo for versioning)
3. **GitHub App vs PAT**: GitHub App (installation tokens) or Personal Access Tokens? (Recommend: GitHub App for multi-tenant, PAT for single-user)

### Agent Design
4. **Agent language**: Same Bun/TS stack, or Python for better AI SDK support? (Recommend: Bun/TS for consistency — Vercel AI SDK works)
5. **Pre-commit hooks**: Enforce in template, or inject by agent? (Recommend: enforce in template, agent runs them)
6. **Automerge safety**: Require 1 approving review or CI-only? (Recommend: CI-only for speed, add reviews later)

### Cost & Operations
7. **OpenRouter key creation**: API endpoint exists to create sub-keys? Or use a master key with spend tracking? (Needs investigation)
8. **Log retention**: How long to keep agent logs? (Recommend: 30 days)
9. **Agent timeout**: Maximum runtime per agent? (Recommend: 30 minutes)

### UX
10. **Grill-me state persistence**: ~~Can user refresh the page and resume?~~ Resolved: the runtime keeps OpenCode alive and the browser reconnects to the terminal; sessions survive a refresh and a backend restart reconciles them.
11. **Issue creation**: ~~Does the user review before creating?~~ Resolved: the agent reports drafts, Finish is the only publish point, and review happens on the Plan and Issue review pages.

---

## Technology Stack Summary

| Layer | Technology | Why |
|---|---|---|
| Frontend | SvelteKit + Tailwind | Dogfood our own template stack, reactive UI |
| Backend | Bun + Hono | Fast startup on K8s, TypeScript-native, single language |
| Database | SQLite (libsql/better-sqlite3/bun:sqlite) | Single file, zero ops, doubles as the session/cache store |
| Cache/Session | None (SQLite + in-process state) | No Redis dependency |
| Terminal | ttyd + xterm.js | Real interactive OpenCode experience; the backend owns the protocol |
| Session runtime | Per-session Pods (Kubernetes) or local child processes | Isolation without giving up a fast local loop |
| LLM Provider | OpenRouter | Multi-model, per-key budget control |
| Git Provider | GitHub (initially) | Largest ecosystem, well-documented API |
| CI/CD | GitHub Actions | Tight GitHub integration |
| Deploy | Agent-driven Deploy Job | No GitOps controller to install or secure |
| Policy | Kyverno + PSA | Kubernetes-native policy engine |
| K8s Runtime | kind (dev) / EKS or GKE (prod) | Developer-friendly, managed production |

---

*Last updated: 2026-11-17*