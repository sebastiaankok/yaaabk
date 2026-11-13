# YAAABK — Plan

## Yet Another AI App Builder for Kubernetes

**Elevator Pitch**: An AI-native Internal Developer Platform that takes you from idea to deployed application on Kubernetes. Brainstorm with AI-powered grill-me sessions, automatically generate GitHub issues from refined plans, and have autonomous agents implement those issues — all from a browser.

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
| 1. Create Project | User provides name + description. YAAABK creates a GitHub repo, bootstraps it from a Svelte+Bun template, and configures ArgoCD to deploy from it. |
| 2. Brainstorm / Plan | User enters a grill-me session (via opencode) to refine their idea. Skill level (expert/beginner) controls the prompt depth. |
| 3. Generate Issues | Once the plan is clear, YAAABK converts it into GitHub issues on the repo. |
| 4. Triage Issues | Issues are labeled `ready`, `refinement-needed`, or `blocked`. |
| 5. Spawn Agents | `ready` issues get an autonomous K8s Job that implements the feature, creates a PR, and auto-merges after CI passes. |
| 6. Auto-Fix | If CI fails, a new agent is spawned to fix the issue (max 3 attempts per issue). |
| 7. Deploy | ArgoCD syncs the merged changes to the cluster. |

### Guiding Principles

- **Secure by default** — least-privilege for agents, PSA/Kyverno policies, ArgoCD project boundaries.
- **Cost-controlled** — per-issue OpenRouter budgets prevent runaway spend.
- **Human in the loop only when needed** — refinement feedback, manual intervention after 3 failures.
- **Kubernetes-native** — everything runs on K8s, uses CRDs, Jobs, and RBAC.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         Browser (Svelte UI)                     │
│  Project Dashboard │ Grill-Me Session │ Issue Board │ Stats     │
└──────────────────────┬──────────────────────────────────────────┘
                       │ HTTP/SSE
                       ▼
┌──────────────────────────────────────────────────────────────────┐
│                    YAAABK Backend (Bun + Hono)                   │
│                                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────────┐  │
│  │ Projects │  │  Auth    │  │  Issues  │  │ Agent Manager  │  │
│  │  API     │  │ (GitHub) │  │  API     │  │                │  │
│  └──────────┘  └──────────┘  └──────────┘  └────────────────┘  │
│                                                                  │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────────┐  │
│  │ OpenCode       │  │ GitHub         │  │ ArgoCD            │  │
│  │ Bridge (SSE)   │  │ Client (Octokit)│  │ Client (API)      │  │
│  └────────────────┘  └────────────────┘  └────────────────────┘  │
└──────────────────────┬───────────────────────────────────────────┘
                       │
        ┌──────────────┼──────────────────┐
        ▼              ▼                   ▼
┌──────────────┐ ┌──────────┐ ┌──────────────────────┐
│  PostgreSQL  │ │  Redis   │ │  OpenCode Service    │
│  (state)     │ │  (sess.) │ │  (sidecar or ext.)   │
└──────────────┘ └──────────┘ └──────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│                   Kubernetes Cluster                             │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Namespace: yaaabk-system                                 │  │
│  │  ┌────────────┐ ┌───────────┐ ┌──────────────────────┐   │  │
│  │  │ YAAABK     │ │ ArgoCD    │ │ Kyverno / PSA        │   │  │
│  │  │ Deployment │ │ Controller│ │ Admission Controller │   │  │
│  │  └────────────┘ └───────────┘ └──────────────────────┘   │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Namespace: project-<id> (user app)                       │  │
│  │  ┌────────────┐ ┌──────────────┐ ┌──────────────────┐   │  │
│  │  │ User App   │ │ Agent        │ │ ServiceAccount   │   │  │
│  │  │ Deployment │ │ Jobs (per-   │ │ (project-scoped) │   │  │
│  │  │            │ │ issue)       │ │                  │   │  │
│  │  └────────────┘ └──────────────┘ └──────────────────┘   │  │
│  └───────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### Key Communication Flows

1. **UI ↔ Backend**: REST API (Hono) + Server-Sent Events for live grill-me sessions
2. **Backend ↔ OpenCode**: YAAABK manages opencode sessions, pipes stdin/stdout to browser via SSE
3. **Backend ↔ GitHub**: Octokit for repo creation, issue management, PRs
4. **Backend ↔ ArgoCD**: ArgoCD API to create/update Application resources
5. **Backend ↔ K8s API**: Create Jobs, ServiceAccounts, RoleBindings per issue
6. **Agent ↔ GitHub**: Clone repo, create branches, push commits, open PRs
7. **Agent ↔ OpenRouter**: LLM calls with per-issue API key/budget

---

## 3. Component Breakdown

### 3.1 Frontend (Svelte + Bun)

**Framework**: SvelteKit (because Svelte is the template target — eat your own dogfood)
**CSS**: Tailwind CSS
**Real-time**: Server-Sent Events for grill-me session streaming

**Pages**:
| Route | Purpose |
|---|---|
| `/` | Landing / project list |
| `/projects/new` | Create project wizard |
| `/projects/:id` | Project dashboard (stats, open/closed issues) |
| `/projects/:id/plan` | Grill-me session UI |
| `/projects/:id/issues` | Issue board (kanban-ish) |
| `/settings` | GitHub connection, preferences |

### 3.2 Backend (Bun + Hono)

**Runtime**: Bun (fast startup, TypeScript native)
**Framework**: Hono (lightweight, fast, K8s-friendly)
**Database**: Drizzle ORM + PostgreSQL
**Session Store**: Redis (for opencode session state)

**API Modules**:

| Module | Endpoints | Purpose |
|---|---|---|
| Auth | `POST /auth/github` | GitHub OAuth login |
| Projects | `CRUD /projects` | Project lifecycle + bootstrap |
| Plans | `POST /projects/:id/plan` | Manage plan documents |
| GrillMe | `GET /projects/:id/grill` | SSE stream for grill-me |
| Issues | `CRUD /projects/:id/issues` | Issue management |
| Agents | `POST /projects/:id/issues/:id/spawn` | Trigger agent Jobs |
| Stats | `GET /projects/:id/stats` | Open/closed counts, velocity |

### 3.3 OpenCode Bridge

This is the most novel component. YAAABK needs to:

1. **Start an opencode session** inside a container (sidecar or K8s Job)
2. **Pipe user messages** from the browser into opencode's stdin
3. **Stream opencode's stdout** back to the browser via SSE
4. **Intercept structured output** (e.g., "ISSUES_CREATED") to trigger GitHub issue creation

**Architecture options**:
- **Option A (simpler)**: OpenCode runs as a sidecar container in the YAAABK pod. YAAABK manages its process lifecycle.
- **Option B (more scalable)**: OpenCode runs in per-session K8s Jobs. YAAABK streams I/O via WebSocket/SSE.

**Recommendation**: Start with **Option A** for simplicity. Move to Option B when sessions need isolation or scale.

### 3.4 Agent System

**Per-Issue K8s Job**:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: agent-issue-<id>
  namespace: project-<id>
spec:
  template:
    spec:
      serviceAccountName: agent-<project-id>
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
- ArgoCD Application manifest in `/deploy/` directory
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
├── argo_app_name: string
├── k8s_namespace: string
├── skill_level: "beginner" | "expert"
├── gh_installation_id: number (GitHub App)
├── created_at: timestamp
├── updated_at: timestamp
│
├── Plan
│   ├── id: uuid
│   ├── project_id: uuid FK
│   ├── version: int
│   ├── content_markdown: text
│   ├── skill_level: string
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
│   ├── label: "ready" | "refinement-needed" | "blocked"
│   ├── attempt_count: int (default 0)
│   ├── max_attempts: int (default 3)
│   ├── budget_cents: int (default configurable)
│   ├── openrouter_key_id: string (nullable)
│   ├── closed_at: timestamp (nullable)
│   └── created_at: timestamp
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
[User]                    [YAAABK]                    [GitHub]          [ArgoCD]          [K8s]
  │                          │                          │                  │                 │
  │── POST /projects ───────►│                          │                  │                 │
  │  {name, desc, level}    │                          │                  │                 │
  │                          │── POST /repos ──────────►│                  │                 │
  │                          │◄── repo_url ─────────────│                  │                 │
  │                          │                          │                  │                 │
  │                          │── Push template ────────►│                  │                 │
  │                          │                          │                  │                 │
  │                          │── Create namespace ──────│──────────────────│────────────────►│
  │                          │── Create SA + RBAC ──────│──────────────────│────────────────►│
  │                          │                          │                  │                 │
  │                          │── POST Application ─────│──────────────────►│                 │
  │                          │                          │                  │── sync ────────►│
  │                          │                          │                  │◄── deployed ────│
  │                          │◄── Application synced ───│──────────────────│                 │
  │◄── 201 Created ──────────│                          │                  │                 │
  │  {project, repo, argo}  │                          │                  │                 │
```

### 5.2 Plan Refinement Flow (Grill-Me)

```
[User Browser]          [YAAABK Backend]          [OpenCode Sidecar]
     │                        │                        │
     │── GET /grill (SSE) ────►                        │
     │                        │── Spawn opencode ─────►│
     │                        │◄── session ready ──────│
     │◄── SSE: session_start ─│                        │
     │                        │                        │
     │── POST /grill/message ─►                        │
     │  {text: "I want..."}  │── stdin ───────────────►│
     │                        │                        │
     │◄── SSE: stream tokens ─│◄── stdout (token) ─────│
     │   ...(live streaming)  │                        │
     │                        │                        │
     │── POST /grill/action ──►                        │
     │  "generate_issues"    │── stdin ───────────────►│
     │                        │                        │
     │◄── SSE: issues_created ─│◄── structured JSON ───│
     │  [{title, body}]      │                        │
     │                        │                        │
     │                        │── POST /issues ───────►│ (to GitHub + DB)
     │◄── issues list ────────│                        │
```

### 5.3 Agent Implementation Flow

```
[YAAABK]                 [K8s]                   [Agent Pod]           [GitHub]            [ArgoCD]
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
   │                       │                        │                    │── Sync ──────────►│
   │                       │                        │                    │                   │
   │── Update issue ───────│                        │                    │                   │
   │   status=closed       │                        │                    │                   │
```

### 5.4 Auto-Fix Flow (Pipeline Failure)

```
[GitHub Actions]         [YAAABK]                 [K8s]                  [Agent Pod]
     │                       │                       │                       │
     │── CI fails on PR ────►│                       │                       │
     │  (webhook)            │                       │                       │
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
│  │ yaaabk-system namespace                                   │   │
│  │ ● YAAABK app SA: cluster-level ArgoCD + K8s API access   │   │
│  │   (creates Projects, Applications, Namespaces)            │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ project-<id> namespace                                    │   │
│  │ ● agent-<id> SA:                                         │   │
│  │   - Read-only access to its own namespace                 │   │
│  │   - NO cluster access                                     │   │
│  │   - GitHub token (repo scope) in a Secret                 │   │
│  │   - OpenRouter key in a Secret                            │   │
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

### 6.3 ArgoCD Project Restrictions

Each project gets an ArgoCD Project that restricts:

- **Source repos**: Only the project's GitHub repo
- **Destination clusters**: Only the local cluster
- **Destination namespaces**: Only `project-<id>`
- **Resource types**: Only Deployment, Service, Ingress, ConfigMap, Secret
- **Sync policy**: Automated with Prune

### 6.4 GitHub Token Scoping

| Token | Scope | Used By |
|---|---|---|
| GitHub App Installation Token | Contents: write, Pull Requests: write, Issues: write, Metadata: read | YAAABK backend |
| Per-Project PAT | Contents: write (on its repo only), Pull Requests: write | Agent Jobs |

---

## 7. Cost Control

### 7.1 Per-Issue OpenRouter Budget

**Mechanism**: Create a limited API key via OpenRouter's API for each issue.

```
┌──────────────────────────────────────────────────┐
│ Issue Budget Configuration                       │
│                                                  │
│ Default: $0.50 per issue                         │
│ User can override when creating issue            │
│ Max: $5.00 per issue (system limit)              │
│                                                  │
│ Budget covers: LLM calls for agent + refinement  │
│ If budget exhausted → agent pauses, requests     │
│ human approval for top-up                        │
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
- [ ] Set up monorepo structure (frontend + backend + agent + templates)
- [ ] Set up CI/CD for YAAABK itself
- [ ] Set up development environment (local K8s via kind/minikube)
- [ ] Deploy PostgreSQL + Redis to cluster

### Phase 1: Core Platform (Week 3-5)

- [ ] **Auth**: GitHub OAuth login
- [ ] **Projects API**: CRUD + GitHub repo creation via GitHub App
- [ ] **Template system**: Scaffold Svelte+Bun repos from template
- [ ] **ArgoCD integration**: Create ArgoCD Application + Project per new project
- [ ] **Namespace provisioning**: Create `project-<id>` namespace with policies
- [ ] **Basic UI**: Project list, create project wizard, project dashboard

### Phase 2: Plan & Issues (Week 6-8)

- [ ] **OpenCode Bridge**: Sidecar integration, stdin/stdout management, SSE streaming
- [ ] **Grill-Me Session UI**: Real-time chat interface in browser
- [ ] **Skill level prompts**: Expert vs beginner prompt templates
- [ ] **Issue generation**: Parse grill-me output → create GitHub issues
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
- [ ] **ArgoCD project restrictions**: Lock down source repos and destinations
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
1. **OpenCode integration**: Sidecar in the YAAABK pod, or per-session K8s Job? (Recommend: start with sidecar)
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
10. **Grill-me state persistence**: Can user refresh the page and resume? (Requires Redis session store)
11. **Issue creation**: From grill-me output, does user review before creating? (Recommend: yes — show preview, let user edit)

---

## Technology Stack Summary

| Layer | Technology | Why |
|---|---|---|
| Frontend | SvelteKit + Tailwind | Dogfood our own template stack, reactive UI |
| Backend | Bun + Hono | Fast startup on K8s, TypeScript-native, single language |
| Database | PostgreSQL + Drizzle ORM | Reliable, well-supported, Drizzle is type-safe |
| Cache/Session | Redis | OpenCode session state, rate limiting |
| LLM Provider | OpenRouter | Multi-model, per-key budget control |
| Git Provider | GitHub (initially) | Largest ecosystem, well-documented API |
| CI/CD | GitHub Actions | Tight GitHub integration |
| GitOps | ArgoCD | Industry standard, CRD-based |
| Policy | Kyverno + PSA | Kubernetes-native policy engine |
| K8s Runtime | kind (dev) / EKS or GKE (prod) | Developer-friendly, managed production |

---

*Last updated: 2026-11-13*