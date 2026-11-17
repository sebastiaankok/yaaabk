# @yaaabk/grill-mcp

The stdio MCP server a Grill-Me Session runs next to OpenCode. It gives the
agent a typed way to hand its work back to YAAABK, instead of scanning stdout for
markers.

## Tools

| Tool | Arguments | Effect |
| --- | --- | --- |
| `report_prd` | `{ prd: string }` | Stores the PRD as a draft on the session |
| `report_issues` | `{ issues: Array<{ title, body?, labels?, depends_on? }> }` | Validates and stores the Issue list as a draft |
| `session_status` | `{}` | Reads the session status and draft counts |

Reports are drafts. YAAABK publishes them only when the Developer clicks
**Finish**, which creates the Plan version and replaces that Plan's Issues. That
keeps an abandoned session out of Plan history.

Validation rejects the whole payload when any Issue lacks a title or has a
non-string `labels`/`depends_on` entry, so a correction is actionable and a
half-formed draft is never stored. The backend applies the same rules.

## Configuration

The runtime injects three variables; nothing is read from disk:

| Variable | Purpose |
| --- | --- |
| `YAAABK_API_URL` | Backend base URL, e.g. `http://backend:3000` |
| `YAAABK_SESSION_ID` | The session the tools report to |
| `YAAABK_REPORT_TOKEN` | The per-session bearer token |

Every call sends `Authorization: Bearer <token>`. The backend resolves the
session from the token, so the agent never holds the Developer's cookie. A
missing variable exits non-zero; nothing is written to stdout except protocol
messages. Each call gives up after 10 seconds and reports the URL it could not
reach, so a backend that is down or behind the wrong port fails the tool call
instead of hanging it.

## Image wiring

`packages/agent/Dockerfile` builds this package into `/app/grill-mcp` and ships
`packages/agent/opencode-session.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "skills": ["/app/grill-skills"],
  "mcp": {
    "servers": {
      "yaaabk": {
        "type": "local",
        "command": ["bun", "/app/grill-mcp/index.js"],
        "codemode": false
      }
    }
  }
}
```

`codemode: false` puts the three tools on the model's native tool list, so a
direct call cannot fail because the model wrote invalid Code Mode JavaScript.
Sessions load the file through `OPENCODE_CONFIG` (set from
`YAAABK_SESSION_OPENCODE_CONFIG`), so Agent Jobs sharing the image do not
register the server.

## Protocol

Standard MCP JSON-RPC 2.0 over newline-delimited stdio: `initialize`, `ping`,
`tools/list`, `tools/call`, and the `notifications/initialized` notification.
Tool failures come back as `{ content, isError: true }` with a message the agent
can correct; unknown tools and methods are JSON-RPC errors.

## Tests

```sh
bun run --filter '@yaaabk/grill-mcp' test:unit
```

The suite drives the protocol handler with a fake client and the HTTP client
with a fake `fetch`, so it needs no OpenCode process, backend or model.
