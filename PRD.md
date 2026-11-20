# PRD: YAAABK — Yet Another AI App Builder for Kubernetes

## Problem Statement

Building and deploying applications on Kubernetes requires navigating a fragmented toolchain: GitHub for code, a CI system for testing, a deploy path, and an LLM provider for AI assistance. Developers spend more time stitching these together than building their actual product. Teams new to the ecosystem find the learning curve insurmountable; experienced teams waste time on repetitive boilerplate.

An earlier Grill-Me Session spawned an `opencode` child process in the backend and streamed a bespoke chat UI through Server-Sent Events and a hand-rolled marker protocol (`<QUESTION>`, `<PLAN>`, `<ISSUES>`). That could not run the real OpenCode experience, had no repository or cluster context, put an LLM with shell and file tools next to the backend's credentials, produced a thin Plan and a flat issue list, and lost the work when the session ended.

## Solution

YAAABK is an AI-native Internal Developer Platform that a Platform Admin installs on a Kubernetes cluster. A Developer creates a Project and grills an idea in a **real interactive OpenCode terminal** running in a hardened, per-session Pod in the Project's Namespace. The session hands off from grilling to a PRD to tracer-bullet Issues, and **Finish** publishes them as one Plan version labelled "Plan (PRD)" and replaces that Plan's Issues. Autonomous Agents then implement each Issue — creating PRs, running CI, and deploying — all from the browser.

- **The browser gets a terminal, not a chat.** The Plan page hosts an xterm.js terminal connected to ttyd running `opencode mini` inside the session Pod. The Developer types, scrolls, resizes and sees tool output exactly as they would locally.
- **Each session is its own Pod** in the Project's Namespace under the `yaaabk-agent` identity: read-only pods, logs, deployments, configmaps, events and httproutes, plus `pods/exec`, and no Secret reads. The backend never runs OpenCode for a session and never shares its own credentials with one.
- **The Pod starts with context.** An init container clones the Project repository with a short-lived `contents:read` GitHub App token and removes the credential from the remote. The opening prompt carries the Developer's idea, Project mode, Project identity and active Plan, and tells the agent to load the `grill-me` skill.
- **Three explicit skills.** `grill-me` interviews one question at a time in guided mode and decides every checkpoint itself in autonomous mode; `to-prd` synthesises a PRD; `to-issues` breaks the PRD into vertical slices. The handoff is automatic after the guided confirmations, and unconditional in autonomous mode.
- **Reporting is a typed tool call, not stdout parsing.** A local stdio MCP server exposes `report_prd`, `report_issues` and `session_status`. Reports are stored as drafts on the session and are only published when the Developer clicks **Finish**, in both modes.
- **The model is a per-session choice** from a live, tool-capable OpenRouter catalogue, with the Project remembering the last-used model. Each session gets its own budget-limited OpenRouter key that is revoked when the session ends.
- **Failures are explained.** Starting a session waits for the Pod and terminal to become ready; on failure the API returns the Pod's real reason instead of a generic message.
- **The old paths are gone.** The SSE chat, answer/refine endpoints, marker parser, backend OpenCode spawner, one-shot issue generation and issue refinement are removed. Finish is the only publish point; Cancel discards drafts.

## User Stories

1. As a **Developer**, I want to start a Grill-Me Session from my Project's Plan page, so that I can turn a rough idea into a specification without leaving YAAABK.
2. As a **Developer**, I want the session to be a real interactive terminal in the browser, so that I can see the agent's output, type answers, scroll back and resize the view.
3. As a **Developer**, I want the terminal to behave like my local OpenCode interface, so that the grilling experience is familiar rather than a reduced chat imitation.
4. As a **Developer**, I want each session to run in its own Pod in my Project's Namespace, so that one session cannot interfere with another Project.
5. As a **Developer**, I want the session agent to inspect the cloned Project repository, so that its questions are grounded in the code that exists rather than generic.
6. As a **Developer**, I want the session agent to inspect my Project's running pods, logs, deployments, services, configmaps and httproutes, so that it can answer operational questions without me pasting output.
7. As a **Developer**, I want the session agent to be able to exec into my Project's pods for debugging context, so that it can explain what is actually happening inside the application.
8. As a **Developer**, I want the session agent's cluster access to be read-only plus exec, so that brainstorming cannot mutate or delete my workloads.
9. As a **Developer**, I want the session agent to be unable to read Kubernetes Secrets, so that inspecting the Project does not expose credentials.
10. As a **Developer**, I want the repository cloned with a short-lived read-only GitHub App token, so that the session can read code without holding long-lived repository authority.
11. As a **Developer**, I want the clone credential removed from the workspace after cloning, so that the agent cannot push or leak it.
12. As a **Developer**, I want to choose the model for a session from a live OpenRouter catalogue, so that I can trade cost against quality.
13. As a **Developer**, I want the catalogue filtered to models that support tool calling, so that I cannot pick a model that breaks the session.
14. As a **Developer**, I want my Project to remember the last-used model, so that subsequent sessions start with my preferred choice.
15. As a **Developer**, I want a sensible default model when the Project has no choice yet, so that the first session works without configuration.
16. As a **Developer**, I want each session to receive its own budget-limited OpenRouter key, so that a runaway session cannot spend without a ceiling.
17. As a **Developer**, I want the session key revoked when the session finishes, is cancelled or fails, so that no standing key remains.
18. As a **Developer**, I want a clear error when the platform has no OpenRouter management credential, so that I know what to fix in Settings.
19. As a **Developer**, I want the session to load the YAAABK grill-me skill automatically, so that I do not have to paste instructions.
20. As a **Developer**, I want the session to ask one question at a time, so that the conversation stays focused and each answer resolves one branch.
21. As a **Developer**, I want to choose a guided or autonomous Project mode, so that the agent either interviews me at each checkpoint or decides everything itself and only shows me the finished Plan and Issues.
22. As a **Developer**, I want the agent to explore the repository or cluster instead of asking questions it can answer, so that I spend my time on real decisions.
23. As a **Developer**, I want the agent to stop grilling and, in guided mode, confirm that the plan is settled, so that the session does not run indefinitely.
24. As a **Developer**, I want the agent to synthesise a PRD from the conversation, so that the outcome is a durable document rather than chat history.
25. As a **Developer**, I want the PRD to follow a consistent template with problem, solution, user stories, implementation decisions, testing decisions, out of scope and notes, so that Plans are comparable across Projects.
26. As a **Developer**, I want guided sessions to show me the proposed modules in the PRD and let me correct them, so that the technical shape is reviewed before Issues are written.
27. As a **Developer**, I want the agent to turn the PRD into vertical-slice Issues, so that each Issue cuts end to end through schema, API, UI and tests.
28. As a **Developer**, I want each Issue to be independently grabbable by an Agent, so that concurrency and ordering are explicit.
29. As a **Developer**, I want Issues to declare what blocks them, so that Agents do not start work whose dependencies are incomplete.
30. As a **Developer**, I want HITL slices labelled `needs-human` and AFK slices labelled `ready`, so that the Issue board reflects which work needs me.
31. As a **Developer**, I want guided sessions to quiz me on the proposed Issue breakdown and iterate before reporting it, so that granularity and dependencies are right.
32. As a **Developer**, I want to say "write the PRD now" at any point, so that I can skip remaining grilling when I already know what I want.
33. As a **Developer**, I want the PRD and Issues reported through a typed tool, so that malformed output is rejected with a correction the agent can act on.
34. As a **Developer**, I want reports stored as drafts until I finish, so that an abandoned session never pollutes my Plan history.
35. As a **Developer**, I want a **Finish** action that publishes the PRD and Issues together, so that the Project only changes when I decide it should.
36. As a **Developer**, I want Finish to warn me when no PRD or no Issues have been reported, so that I do not end a session with nothing saved.
37. As a **Developer**, I want to force Finish after the warning, so that I can publish a PRD-only session deliberately.
38. As a **Developer**, I want **Cancel** to discard drafts after a confirmation, so that abandoning a mistaken session leaves no trace in Plans or Issues.
39. As a **Developer**, I want only one active session per Project, so that two terminals cannot race to publish competing Plans.
40. As a **Developer**, I want starting a new session to cancel the previous one, so that the Project always has a single current grilling conversation.
41. As a **Developer**, I want the session to survive a page refresh, so that leaving the Plan page does not kill the conversation.
42. As a **Developer**, I want the session to survive a backend restart, so that a deploy or crash does not lose my in-flight grilling.
43. As a **Developer**, I want the terminal to replay prior output when I reconnect, so that I can see what happened while I was away.
44. As a **Developer**, I want sessions reaped after 30 minutes of inactivity, so that forgotten sessions do not hold resources forever.
45. As a **Developer**, I want a four-hour hard cap, so that even an active but abandoned session cannot run indefinitely.
46. As a **Developer**, I want a clear failure reason when a session cannot start, so that I can distinguish an image problem from a credential or quota problem.
47. As a **Developer**, I want the Plan page to show the terminal while the session is live and the saved Plan and Issues after Finish, so that the workflow has one obvious home.
48. As a **Developer**, I want the Plan to be labelled "Plan (PRD)" in the UI, so that the terminology matches the document the agent produced.
49. As a **Developer**, I want the Issue review page to stop offering one-shot generation and prompt-based refinement, so that the only way to change a Plan or its Issues is another grilling session.
50. As a **Developer**, I want a clear route from the Issue review page back to grilling, so that I can iterate on the PRD instead of editing Issues by hand.
51. As a **Developer**, I want destructive actions blocked inside the session, so that a confused model cannot push, apply, delete or patch.
52. As a **Developer**, I want routine reads and inspections to run without permission prompts, so that the grilling conversation is not interrupted.
53. As a **Developer**, I want my session conversation to be ephemeral, so that sensitive design discussion is not retained after the Pod is gone.
54. As a **Developer**, I want to grill again on an existing Project with its active Plan and repository as context, so that feature development continues from where the last session stopped.
55. As a **Platform Admin**, I want the backend to create only session Pods and NetworkPolicies inside Project Namespaces, so that its cluster authority stays narrow.
56. As a **Platform Admin**, I want session ingress restricted to the backend proxy, so that the terminal is never directly exposed to the cluster or the internet.
57. As a **Platform Admin**, I want session egress restricted to the backend, the Kubernetes API, GitHub and OpenRouter, so that a terminal cannot reach arbitrary hosts.
58. As a **Platform Admin**, I want session Pods to satisfy Pod Security `restricted`, so that the platform's admission policy is unchanged.
59. As a **Platform Admin**, I want the agent image to carry a pinned OpenCode version, ttyd, the MCP server and the grill skills, so that sessions and Agent Jobs share one reproducible runtime.
60. As a **Platform Admin**, I want the existing Agent Jobs to use the same pinned OpenCode and model configuration, so that installing the CLI does not leave Agent runs broken in a new way.
61. As a **Developer**, I want `docker compose` to support local grill sessions, so that I can develop the workflow without a Kubernetes cluster.
62. As a **Developer**, I want host-based local development to work with ttyd and OpenCode on my PATH, so that iteration is fast.
63. As a **Developer**, I want the old SSE and marker-based session API removed, so that there is one session model to reason about.
64. As a **Developer**, I want the session runtime behind a port with Kubernetes and local adapters, so that the risky orchestration logic is testable without a cluster.
65. As a **Developer**, I want sessions cleaned up after a backend restart, so that orphaned Pods, keys and tokens do not accumulate.

## Implementation Decisions

### Modules

**Refactored**

- **Grill-Me module.** The backend-side session orchestrator: start, get, finish, cancel, draft storage, per-session token validation, idle and hard-cap timers, and restart reconciliation. It owns the prompt builder, report validation and the publishing transaction. It does not spawn OpenCode, parse markers or stream tokens.
- **SessionRuntime port (deep module inside Grill-Me).** A narrow interface: `start(spec)`, `stop(ref)`, `inspect(ref)`, `list(filter)`. A Kubernetes adapter creates Pods and NetworkPolicies; a local adapter runs ttyd and OpenCode as child processes. Both adapters satisfy the same contract suite, and backend routes only depend on the port.
- **Terminal proxy module (deep module).** Owns browser WebSocket authentication, the upstream ttyd connection, ttyd frame translation, resize handling, reconnect semantics and last-activity tracking. It is independent of session lifecycle and can be tested against a stub upstream.
- **MCP reporting module.** A standalone stdio MCP server shipped in the session image. It exposes typed tools, validates arguments, attaches the per-session bearer token and posts to the report endpoint. It has no dependency on backend-only modules.

**Extended**

- **Kubernetes client.** Pod create/get/list/delete, Pod IP, Pod phase and waiting-reason/events, plus NetworkPolicy creation and deletion.
- **Projects module.** Persist the last-used grill model on the Project.
- **Cost control.** Mint a key for a generic session subject (not only an Issue), return the key and its hash, and support revocation by hash.
- **Agent runtime and image.** A pinned OpenCode CLI, ttyd, the MCP server, the three grill skills and a session entrypoint. The existing non-interactive agent invocation passes a model and non-interactive permission behaviour.
- **Backend.** Session routes, report route, terminal WebSocket route, model catalogue proxy, timers and reconciliation wiring.
- **Frontend.** An xterm.js terminal component with reconnect/resize, a searchable model picker, session state handling, Finish/Cancel flows, and no SSE chat, generated-issue or refine UI.

**Unchanged**

- **Plans and Issues modules.** Publishing uses the existing versioned Plan creation and per-Plan Issue replacement. No schema change is required in either module.

### Session record

A Grill-Me Session record stores: project, status (`starting`, `active`, `finishing`, `finished`, `cancelled`, `failed`), Project mode, model, runtime reference (Pod name or local process id), report-token hash, OpenRouter key hash, draft PRD markdown, draft Issues as JSON, last activity time, start time, end time, end reason and a human-readable error when failed.

Drafts live only on the session row. Publishing is the only operation that writes Plans or Issues.

### API contracts

- `POST /api/projects/:id/grill` starts a session with an idea and an optional model. It waits for readiness and returns the session id. On failure it returns a bad-gateway response carrying the Pod's real waiting reason.
- `GET /api/projects/:id/grill` returns the active session, or not-found when none is live.
- `GET /api/projects/:id/grill/:sessionId/terminal` upgrades to a WebSocket for the terminal. It requires the Developer's session cookie.
- `POST /api/projects/:id/grill/:sessionId/finish` publishes drafts. Without both a PRD and at least one Issue it returns a conflict listing what is missing; a forced request publishes what exists.
- `POST /api/projects/:id/grill/:sessionId/cancel` stops the runtime, discards drafts and marks the session cancelled.
- `POST /api/grill-sessions/:id/report` accepts an optional PRD markdown and optional Issues array. It is authenticated by the per-session bearer token, not the Developer cookie. It validates both before storing either. Issues require a PRD draft.
- `GET /api/models` returns the live OpenRouter catalogue filtered to tool-capable chat models, cached briefly. It requires the Developer session.

The removed endpoints are not part of the API: the old session SSE stream, answer/refine endpoints, one-shot `/issues/generate` and prompt-based `/issues/refine`.

### Terminal protocol

The browser owns the xterm.js instance and speaks a small JSON protocol over its WebSocket: input bytes and resize events. The backend opens a ttyd WebSocket using the `tty` subprotocol, authenticates with the session's ttyd credential, sends the initial size, translates input and resize into ttyd frames, and translates ttyd output, title and preference frames back into JSON events. The backend tracks activity from frames in both directions.

On reconnect the frontend sends a resize. `opencode mini` runs with replay enabled, so the session history is restored on resize. The runtime keeps OpenCode alive when the browser disconnects; only Finish, Cancel, failure or a timeout stops it.

### Session Pod

- Created in the Project Namespace with the Project's `yaaabk-agent` ServiceAccount.
- An init container clones the Project repository with a short-lived `contents:read` installation token, then rewrites the remote to a credential-free URL. The token Secret is mounted only into the init container.
- The main container runs ttyd in front of `opencode mini` with a deterministic session id, the opening prompt, the selected OpenRouter model, automatic approvals and replay enabled. The workspace is an empty directory.
- Environment supplies the per-session OpenRouter key, report token, API URL, project identity, Project mode and prompt.
- Pod Security `restricted`: non-root, no privilege escalation, all capabilities dropped, default seccomp, explicit CPU and memory limits.
- A NetworkPolicy allows ingress only from the backend and egress only to the backend, the Kubernetes API, GitHub and OpenRouter, plus DNS.
- OpenCode configuration loads the grill skills from the image, registers the reporting MCP server with Code Mode disabled, and applies a deny-list: no `git push`, no `kubectl apply/delete/patch`, no `.env` reads, no external directories, no arbitrary write outside the workspace.

### Skills

- **`grill-me`.** Loads first. Interviews one question at a time in guided mode, decides every checkpoint itself in autonomous mode, inspects the repository and cluster when useful, confirms when the plan is settled in guided mode, and hands off.
- **`to-prd`.** Explores, sketches modules, checks them with the Developer only in guided mode, writes the PRD from the template, and calls `report_prd`.
- **`to-issues`.** Drafts vertical slices, quizzes the Developer on granularity and dependencies in guided mode and validates them itself in autonomous mode, maps AFK to `ready` and HITL to `needs-human`, and calls `report_issues`.
- The handoff is automatic after the guided confirmation gate; autonomous mode has no gate. Finish stays manual in both modes.

### Model and credentials

- The session model comes from the start request. The Project stores it as the last-used value; an environment default applies when absent. The API rejects models outside the tool-capable catalogue.
- The backend mints a per-session OpenRouter key with a session budget and expiry, stores its hash on the session and injects the plaintext only into the Pod.
- Finish, Cancel, failure and reconciliation delete the key and the ttyd credential.
- If no OpenRouter management credential is configured, start fails with an actionable error.

### Lifecycle and reconciliation

- One active session per Project. Starting another cancels the previous one.
- Sessions are reaped after 30 minutes without terminal activity and after 4 hours from start.
- On backend start, sessions in a transient state are reconciled: live runtimes are re-adopted, missing runtimes are marked failed, and orphaned Pods, keys and tokens are removed.
- Finish publishes in order: create the Plan version, then replace that Plan's Issues. If the second step fails, the session keeps its drafts and can retry without creating a duplicate Plan.

### Deploy and local development

- The agent image is the shared OpenCode runtime for sessions and Agent Jobs.
- The backend's cluster role gains Pod and NetworkPolicy management in Project Namespaces.
- A backend development image stage installs ttyd and OpenCode so `docker compose` can run local sessions. Host development uses the locally installed binaries.
- A Grill-Me Session is an interactive terminal session, not a marker stream.

### Removals

- The backend OpenCode spawner, marker parser, SSE stream, fake spawner and their tests.
- Answer, refine, issue-generation and issue-refinement endpoints and their client functions.
- The Plan page chat, token streaming and SSE state machine.
- The Issue review page's generate and refine actions.
- The environment variable that pointed at a skill file for the old spawner, replaced by image-baked skills.

## Testing Decisions

A good test asserts observable behaviour through a public interface, not internal structure. Tests inject fakes at the existing seams — the in-memory Kubernetes object API, in-memory and SQLite stores, fake GitHub clients, injected clocks — so no test needs a cluster, GitHub or an LLM.

**Primary targets**

- **SessionRuntime contract.** One shared suite runs against the Kubernetes adapter (using the in-memory object API) and the local adapter (using a stub ttyd process). It covers start, readiness, inspection, stop, listing and failure reasons.
- **Report endpoint and draft storage.** Validation rejects malformed Issues and Issues without a PRD; repeated reports replace drafts; drafts never touch Plans or Issues; Finish publishes exactly once and is retry-safe; Cancel discards.
- **Finish guard.** Missing PRD, missing Issues and both missing produce the conflict listing; a forced Finish publishes partial drafts.
- **Terminal proxy.** Against a stub upstream: authentication failure, auth handshake, input and resize translation, output/title/preference translation, activity tracking, disconnect behaviour and reconnect with resize.
- **Token authentication.** Valid scalar comparison, wrong token, expired or cancelled session, and finished session rejection.
- **Model catalogue.** Tool-capable filtering, caching, upstream failure and rejection of a model outside the catalogue.
- **Session lifecycle and reconciliation.** Idle timeout, hard cap, one-active-session rule, backend restart re-adoption, missing-runtime failure and orphan cleanup, all driven by an injected clock.
- **MCP tools.** Tool schemas, argument validation, token/header usage, partial reports and upstream error mapping.
- **Backend routes.** Start, get, finish, cancel and report through a fake runtime and real in-memory modules; status mappings and error bodies. The removed endpoints stay removed.
- **Frontend.** The terminal client against a fake WebSocket: input, resize, reconnect, replay-triggering resize, close and error states. The Plan page with a fake session API: live, finished, failed and guard states. The Issue review page offers no generate or refine actions and links back to grilling.

**Prior art**

The codebase tests module boundaries with in-memory K8s object APIs, fake GitHub clients, injected clocks, fake process spawners and SQLite integration suites. The Plan page and Issue review page keep Playwright coverage for the states that do not require a real OpenCode process.

**Deliberately not automated**

A real `opencode mini` session against a real model is manually smoked before release. CI does not run an LLM, and does not depend on OpenCode's terminal rendering.

## Out of Scope

- Persisting the session transcript or OpenCode conversation history after the Pod ends.
- More than one concurrent grill session per Project.
- Serving the terminal from a separate origin or exposing it outside the backend proxy.
- Per-Project-mode model selection or automatic model routing.
- Publishing PRDs or Issues directly to GitHub from inside the session; the existing sync flow remains the only path.
- A historical session list, replay or resume-after-finish.
- Editing or refining Issues outside a new grill session.
- Per-session persistent volumes.
- Automatic migration of existing Plans or Issues to the PRD content shape.
- A budget-management UI beyond the per-session key cap.
- Real OpenCode/LLM end-to-end tests in CI.
- Tuning the Agent's implement-issue skill or review skill beyond making them run on the pinned OpenCode version.
- Removing or changing the existing Plan upload source.

## Further Notes

- **Why a per-session Pod instead of a backend sidecar.** A terminal is remote code execution by design. Keeping it out of the backend pod means the model never sits next to the auth secret, GitHub App key, OpenRouter management key or cluster-wide backend RBAC. Running it under the Project's read-only agent identity keeps the blast radius at the Project Namespace.
- **Why the agent image is reused.** Sessions and Agent Jobs both need OpenCode, git and kubectl. One pinned runtime means one upgrade path and one place where the CLI version is known to work.
- **Why reports are drafts.** Publishing on every report would leave half-written Plans and orphaned Issues in real history whenever a Developer abandons a session. Drafts keep the Plan version list meaningful and make Finish a single commit point.
- **Why the frontend owns xterm.js.** An iframe would put ttyd's JavaScript on YAAABK's origin, where it could make authenticated API calls as the Developer. A small xterm.js client with frame translation in the backend keeps third-party script off the origin.
- **Why ttyd remains.** It is the PTY owner: it runs the process, handles signals and resizes, and keeps OpenCode alive across browser disconnects. The backend speaks its documented protocol rather than reimplementing PTY handling.
- **Why the model catalogue is live.** OpenRouter's inventory changes frequently. Filtering the live catalogue to tool-capable models keeps choices valid without maintenance.
