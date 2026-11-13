# YAAABK — Yet Another AI App Builder for Kubernetes

An AI-native Internal Developer Platform that takes developers from idea to deployed application on Kubernetes.

## Language

**Platform Admin**:
A person who installs YAAABK on a Kubernetes cluster and configures cluster-level policies, namespaces, and admission controllers. Not responsible for providing application-level secrets or managing projects.
_Avoid_: Operator, cluster admin, sysadmin

**Developer**:
A person who uses the YAAABK browser UI to create projects, brainstorm features, and manage agent-driven development. Brings their own OpenRouter API key and GitHub App credentials. May be an expert or a beginner.
_Avoid_: End-user, customer, user

**Project**:
A software project created by a **Developer**, backed 1:1 by a GitHub (or future GitLab) repository. The repo is the source of truth for code and issues. A Project is inseparable from its repo; the repo cannot be swapped out after creation.
_Avoid_: App, workspace, application

**Namespace (K8s)**:
A Kubernetes namespace that hosts a **Project**'s deployed application and agent infrastructure. Named `project-<short-uuid>` where the short UUID is derived from the Project's internal ID. The namespace has a label `yaaabk.io/project-name: <project-name>` for human readability. Never renamed after creation.
_Avoid_: project-<name>, <user>-<project>

**Skill Level**:
A per-Developer setting that controls the prompt depth of the YAAABK-specific grill-me skill. `beginner` receives simpler, step-by-step questions. `expert` receives deeper architectural questions and opinionated defaults.
_Avoid_: Experience level, difficulty

**Grill-Me Session**:
An interactive AI-driven conversation where a **Developer** refines an idea into a structured **Plan**. Powered by a YAAABK-specific OpenCode skill that asks questions, processes answers, and iterates until the plan is complete. The skill outputs structured markers (`<QUESTION>`, `<PLAN>`, `<ISSUES>`) that YAAABK parses.
_Avoid_: Chat, brainstorming session

**Plan**:
A versioned markdown document produced by a **Grill-Me Session**, representing the refined specification of a **Project**. Stored in the database with version tracking. Can be reviewed in the UI before issues are generated.
_Avoid_: Specification, design doc

**Issue**:
A unit of work derived from a **Plan**. Maps 1:1 to a GitHub Issue on the **Project**'s repository. Has a label (`ready`, `refinement-needed`, `blocked`) and tracks agent implementation attempts. Stored in both GitHub and the local database.
_Avoid_: Task, ticket, story

**Agent**:
An autonomous K8s Job that implements a single **Issue**. Runs OpenCode with a YAAABK-specific `implement-issue` skill that explores the codebase, proposes changes, writes code, runs pre-commit hooks, commits, pushes, and opens a PR with an automerge label. Each Agent is scoped to one Issue and has a maximum of 3 attempts before escalation.
_Avoid_: Bot, worker, runner

## Technology

| Layer | Choice | Why |
|---|---|---|
| Database + Cache | SQLite (via Turso/libsql or better-sqlite3) | Single file, zero ops, no separate service. Good enough for single-user/small-team. Doubles as the session/cache store — no Redis needed. |

## Relationships

- A **Platform Admin** installs YAAABK so that **Developers** can safely create and manage **Projects**.
- A **Developer** creates a **Project**, which creates a GitHub repo and a **Namespace (K8s)**.
- Each **Namespace (K8s)** hosts exactly one **Project**'s application and its agent Jobs.
- A **Grill-Me Session** produces a **Plan**.
- A **Plan** generates zero or more **Issues**.
- Each **Issue** belongs to exactly one **Project** and is backed by a GitHub Issue.
- An **Agent** implements exactly one **Issue**. Multiple **Agent** attempts may exist per **Issue** (up to 3).

## Flagged ambiguities

- "User" was used to mean both Platform Admin and Developer — resolved: these are distinct concepts with different responsibilities.
- "App" was used interchangeably with **Project** — resolved: use **Project** throughout.
- "Issue" was used to mean both a database entity and a GitHub Issue — resolved: they are the same thing, mirrored in both systems.

## Example dialogue

> **Developer:** "I want to create a new project and brainstorm features for a todo app."
> **Platform Admin:** "Great — I've installed YAAABK and configured the cluster policies. You can log in at https://yaaabk.mycompany.com and add your GitHub App and OpenRouter key in Settings."
> **Developer:** "I created 'todo-app'. What namespace did it get?"
> **Platform Admin:** "`project-a1b2c3d4` — check the label `yaaabk.io/project-name: todo-app` to confirm."
> **Developer:** "I submitted my idea and started a grill-me session. It's asking me about authentication strategies now."
> **Platform Admin:** "The skill adapts to your level — sounds like it's working."
