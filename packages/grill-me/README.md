# @yaaabk/grill-me

The Grill-Me Module owns the browser-facing lifecycle of a real terminal
session: one live session per Project, start/get/cancel, activity tracking and
the `SessionRuntime` port. The local adapter runs ttyd in front of
`opencode mini` as child processes; the Kubernetes adapter runs one hardened Pod
per session in the Project Namespace. `createTerminalBridge` translates the
browser's JSON protocol to ttyd's `tty` frames, and `sessionRuntimeContract` is
the shared suite every adapter runs.

The opening prompt tells the agent to load the `grill-me` skill before anything
else. That skill runs the interview, and three bundled skills carry the session
from idea to report:

| Skill | Role |
| --- | --- |
| `grill-me` | Interviews one question at a time, adapts to the Skill Level, explores the repository and cluster instead of asking answerable questions, confirms the settled plan and hands off. |
| `to-prd` | Synthesises the PRD from the conversation, checks the module sketch with the Developer, writes the PRD template and calls `report_prd`. |
| `to-issues` | Cuts the PRD into vertical slices, quizzes the Developer on granularity and dependencies, maps AFK to `ready` and HITL to `needs-human`, and calls `report_issues`. |

The skills live under [`skills/`](./skills) and are baked into the shared agent
image. The session OpenCode config lists the image skills directory, so the
model loads them through OpenCode's `skill` tool rather than pasted prompt text.
The Developer can say "write the PRD now" at any point to skip the rest of the
interview.

There is no marker protocol or stdout parsing: the agent reports through the
typed MCP tools in `@yaaabk/grill-mcp`, and Finish is the only publish point.

## Interactive sessions

```ts
import { createGrillSessionsModule, createLocalSessionRuntime } from '@yaaabk/grill-me';

const sessions = createGrillSessionsModule({
  runtime: createLocalSessionRuntime(),
  defaultModel: 'openrouter/anthropic/claude-sonnet-4.5',
});

const started = await sessions.start({
  projectId,
  projectName: 'todo-app',
  idea: 'A todo app',
  skillLevel: 'expert',
});

if (started.ok) {
  const terminal = await sessions.terminal(started.value.id);
  // The backend proxy connects to terminal.url with terminal.credential.
}
```

Starting another session for the same Project stops and replaces the previous
one. Cancel stops the runtime and ends the session. The session view never
contains the ttyd credential; only `terminal()` returns it, to the backend
proxy.

### Lifecycle and restart recovery

Sessions are persisted through a `GrillSessionStore` (in-memory by default; the
backend uses `createSqliteGrillSessionStore`). A session is reaped after 30
minutes without terminal activity and stopped at four hours from start,
whichever comes first. `sweep()` applies both rules through the injected clock:

```ts
const swept = await sessions.sweep();
// { ended: [sessionId] }
```

Each reaped session is marked `failed` with `endReason: 'timeout'`, its runtime
is stopped, its OpenRouter key is revoked and its report token stops
authenticating. `sweep()` leaves finished and already-ended sessions alone.

On backend start, `reconcile()` compares the persisted sessions with the
runtimes that exist now. Live runtimes are re-adopted (the terminal endpoint is
refreshed from the adapter), missing or failed runtimes mark their session
failed with the runtime's reason, and runtimes no live session owns are stopped.
It also revokes any key or report token a crash left on an ended session. The
Kubernetes adapter rediscovers its Pods by label after a restart, so a new
process can inspect and stop what the previous one created:

```ts
const reconciled = await sessions.reconcile();
// { adopted: [id], failed: [id], stopped: [id] }
```

### Reporting and Finish

The session's agent reports through `@yaaabk/grill-mcp`, authenticated by a
per-session bearer token. The orchestrator mints the token, stores only its
SHA-256 hash and injects the plaintext into the runtime. Reports become drafts:

```ts
await sessions.report(sessionId, reportToken, { prd: '# Plan (PRD)' });
await sessions.report(sessionId, reportToken, { issues });
```

A report with Issues needs a PRD draft, first or in the same call. Repeated
reports replace the drafts; they never create Plans or Issues. `finish` is the
only publish point:

```ts
const published = await sessions.finish(projectId, sessionId);
// { session, plan, issues }
```

Without a PRD and at least one Issue it resolves `{ ok: false }` with
`kind: 'incomplete'` and `missing: ['prd', 'issues']`; `{ force: true }` publishes
the drafts that exist. Finish creates one Plan version and replaces that Plan's
Issues, then stops the runtime. It records the Plan as soon as it exists, so a
retry after a failed Issue publish reuses that version, and finishing an already
finished session returns the same Plan and Issues. Cancel discards the drafts.

`createLocalSessionRuntime()` waits for ttyd readiness before resolving a start
and reports the failing process's stderr on start failure. Host development uses
`ttyd` and `opencode` from `PATH`; the agent image pins both.

### Kubernetes sessions

```ts
import { createKubernetesSessionRuntime } from '@yaaabk/grill-me';

const sessions = createGrillSessionsModule({
  runtime: createKubernetesSessionRuntime({ k8s, image: agentImage }),
  cloneToken: async ({ repoFullName }) => mintContentsReadToken(repoFullName),
  defaultModel: 'openrouter/anthropic/claude-sonnet-4.5',
});
```

Each start creates a NetworkPolicy, a short-lived clone-token Secret, a
per-session credential Secret and one Pod in the Project Namespace. The Pod runs
under the Project's `yaaabk-agent` ServiceAccount with Pod Security
`restricted`; its init container clones the repository with a `contents:read`
token and rewrites the remote to a credential-free URL, and the token Secret is
never mounted into the main container. The main container runs ttyd and
`opencode mini` in `/workspace/repo` with the opening prompt, selected model and
replay enabled. The adapter waits for the Pod to become Ready and for ttyd to
accept connections, mapping a container waiting reason (for example
`ErrImagePull`) to the start error. Stop deletes the Pod, NetworkPolicy and both
Secrets.

The NetworkPolicy admits ingress only from the backend Pod and permits egress
only to the backend, the Kubernetes API CIDR, HTTPS (GitHub and OpenRouter) and
DNS. The session's ServiceAccount grants read-only workload inspection plus
`pods/exec`, and never Secret reads.

## Design

The session orchestrator depends on the narrow `SessionRuntime` port —
`start`, `stop`, `inspect` and `list` — with local and Kubernetes adapters. Both
adapters satisfy the shared contract suite, so the backend routes never depend
on which one is running. The terminal proxy is independent of session
lifecycle: it authenticates the browser WebSocket, connects to ttyd with the
`tty` subprotocol, translates input and resize into ttyd frames, and translates
output, title and preference frames back. It can be tested against a stub
upstream.

A session survives a browser refresh because the runtime keeps OpenCode alive;
only Finish, Cancel, failure or a timeout stops it.

## Configuration

- `YAAABK_SESSION_OPENCODE_CONFIG` — the OpenCode config sessions load. The
  image ships one that lists `/app/skills` and registers the reporting MCP
  server; Agent Jobs do not load it. Without it, OpenCode only discovers skills
  from the project's own `.opencode/skills`.
- `YAAABK_TTYD_BIN` and `YAAABK_OPENCODE_BIN` — the local adapter's binaries.
  Both default to `ttyd` and `opencode` on `PATH`.
- `YAAABK_SESSION_CWD` — the local adapter's working directory.
- `YAAABK_SESSION_RUNTIME` — `local` (default) or `kubernetes`; the deployment
  sets the latter.

## Tests

```sh
bun run test:unit
```

Covers the runtime contract against both adapters, session lifecycle (start,
finish, cancel, timeouts, reconciliation), draft reporting and publishing,
terminal frame translation, and the prompt builder. The interactive skills are
contract-tested for their one-question, handoff, PRD template and
vertical-slice rules. No test needs a cluster, GitHub or an LLM.
