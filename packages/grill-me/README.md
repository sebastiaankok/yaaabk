# @yaaabk/grill-me

The Grill-Me Module: YAAABK's OpenCode bridge, in two generations.

**Interactive sessions (current).** `createGrillSessionsModule` owns the
browser-facing lifecycle of a real terminal session: one live session per
Project, start/get/cancel, activity tracking and the `SessionRuntime` port. The
local adapter runs ttyd in front of `opencode mini` as child processes; the
Kubernetes adapter will satisfy the same contract. `createTerminalBridge`
translates the browser's JSON protocol to ttyd's `tty` frames, and
`sessionRuntimeContract` is the shared suite every adapter runs.

**Marker stream (legacy).** `createGrillMeModule` spawns `opencode run` and
parses `<QUESTION>`, `<PLAN>` and `<ISSUES>` markers. It remains only for the
one-shot Issue generation endpoints until the legacy path is removed.

The legacy module is transport-free. It emits domain events; the backend adapts
them to Server-Sent Events with `createSseStream`, and drives the conversation
with `submitAnswer`, `refineIssues` and `cancelSession`.

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

## Usage (legacy)

```ts
import { createGrillMeModule, createSseStream } from '@yaaabk/grill-me';

const grillMe = createGrillMeModule();

grillMe.on('question', ({ sessionId, question }) => {
  // push to the browser
});

const started = await grillMe.startSession(projectId, 'A todo app', 'beginner');
if (!started.ok) {
  // started.error.kind is 'invalid-input' | 'spawn-failed' | ...
} else {
  await grillMe.submitAnswer(started.value, 'Postgres, please');
}
```

Every command resolves to a `GrillMeResult` — `{ ok: true, value }` or
`{ ok: false, error }` — so callers branch on `ok` instead of catching
exceptions. Nothing throws across the module boundary.

### Events

`on(event, handler)` returns a disposer. Handlers receive the session id, so a
single module can serve many sessions.

| Event | Payload |
|---|---|
| `token` | `{ sessionId, text }` — raw stream text, for the live typing effect |
| `question` | `{ sessionId, question }` |
| `plan_ready` | `{ sessionId, plan }` — the final Plan as Markdown |
| `issues_generated` | `{ sessionId, issues }` — parsed `{ title, body, labels, depends_on }` |
| `error` | `{ sessionId, error }` — a typed `GrillMeError` |
| `ended` | `{ sessionId, reason }` — `completed \| failed \| cancelled \| timeout` |

### Commands

| Command | Effect |
|---|---|
| `startSession(projectId, idea, skillLevel)` | Spawns the OpenCode process and resolves the session id |
| `submitAnswer(sessionId, answer)` | Writes the Developer's answer to the process stdin |
| `refineIssues(sessionId, feedback)` | Asks the agent for a revised `<ISSUES>` block |
| `cancelSession(sessionId)` | Ends the session and stops the process |

### Timeout

A session is cancelled after 30 minutes (`timeoutMs` overrides it). The process
is stopped and an `ended` event with reason `timeout` is emitted.

### SSE

```ts
import { createSseStream } from '@yaaabk/grill-me';

app.get('/projects/:id/grill/:sessionId', (c) =>
  c.body(createSseStream(grillMe, c.req.param('sessionId'))),
);
```

The stream filters out other sessions' events, sends keep-alive comments while
idle (`heartbeatMs`, 0 to disable), and closes when the session ends.

## Design

The high-level module depends on a narrow, process-shaped port —
`OpenCodeSpawner` (`spawn`) and `OpenCodeProcess` (`send`, `stop`, `exited`). The
real adapter shells out to the `opencode` CLI; unit tests inject
`createFakeSpawner()`, so the whole module is testable with no cluster, network
or LLM.

Marker parsing is incremental (`createMarkerParser`): chunks may split a marker
in half, and text that could still become a marker is held back rather than
leaking to the browser.

## Configuration

- `YAAABK_GRILL_ME_SKILL` — path to the grill-me skill. Defaults to the bundled
  [`skills/grill-me`](./skills/grill-me/SKILL.md).
- `createOpenCodeSpawner({ command, args, env, cwd })` — the real `opencode`
  invocation. The exact CLI invocation may need tuning against the installed
  OpenCode version; the session context is passed both as the opening prompt and
  as `YAAABK_*` environment variables.

## Tests

```sh
bun run test:unit
```

Covers the streaming marker parser, issue parsing, session lifecycle (events,
timeout, cancellation, process exit), the SSE stream and the real spawner
(exercised against a stand-in command), all without an LLM or a cluster.
