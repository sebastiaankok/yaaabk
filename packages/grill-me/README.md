# @yaaabk/grill-me

The Grill-Me Module: YAAABK's OpenCode bridge. It owns the lifecycle of an
OpenCode session, parses the structured markers the grill-me skill emits
(`<QUESTION>`, `<PLAN>`, `<ISSUES>`), and streams the results as events.

The module is transport-free. It emits domain events; the backend adapts them to
Server-Sent Events with `createSseStream`, and drives the conversation with
`submitAnswer`, `refineIssues` and `cancelSession`.

## Usage

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
