# Agent guide

This repository is a YAAABK scaffold: a SvelteKit single-page app served by a
Bun + Hono API. Read this file before exploring; it names the files and commands
you need.

## Repository map

| Path                     | What it is                                                      |
| ------------------------ | --------------------------------------------------------------- |
| `web/src/routes/`        | SvelteKit pages; `+page.svelte` is the UI                       |
| `web/src/app.css`        | Tailwind entry point                                            |
| `server/src/app.ts`      | Hono app: `/health`, `/api/*` and the static SPA fallback       |
| `server/src/app.test.ts` | API tests run with `bun test`                                   |
| `server/src/index.ts`    | Server entry point; `PORT` selects the listen port              |
| `scripts/smoke.ts`       | Starts the API and checks `/health` and `/api/hello` end-to-end |
| `deploy/`                | Kubernetes manifests applied by the YAAABK deploy Job           |

## Commands

Run these from the repository root.

| Command                         | What it does                                                     |
| ------------------------------- | ---------------------------------------------------------------- |
| `bun install --frozen-lockfile` | Install dependencies from the committed lockfile                 |
| `bun run dev`                   | API and SvelteKit dev servers with hot reload                    |
| `bun run check`                 | Lint, typecheck, tests and the production build                  |
| `bun run smoke`                 | Start the API on an ephemeral port, check the endpoints, stop it |
| `bun run build`                 | Build `web/build` and the server bundle (also in `check`)        |
| `bun run start`                 | Run the built server                                             |

Run `bun run check` and `bun run smoke` before you finish a change. Both must
pass; YAAABK runs them again after you stop.

## Constraints

- **No browser.** Do not start a browser, install Playwright or Chromium, or
  take screenshots. `bun run smoke` is the end-to-end check for the API and the
  server wiring.
- **Do not add `.yaaabk/`.** That directory is for local Agent verdicts and is
  gitignored; never commit it.
- **Keep changes focused.** Implement the Issue and nothing else, and match the
  surrounding code's structure, naming and style.
- **There is no pre-commit hook.** `bun run check` is the single definition of
  the project's checks; do not look for or install a hook.
