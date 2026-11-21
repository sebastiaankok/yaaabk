# Agent guide

This repository is a YAAABK scaffold: a SvelteKit single-page app served by a
Bun + Hono API. Read this file before exploring; it names the files and commands
you need.

## Repository map

| Path                          | What it is                                                           |
| ----------------------------- | -------------------------------------------------------------------- |
| `web/src/routes/`             | SvelteKit pages; `+page.svelte` is the UI                            |
| `web/src/routes/page.test.ts` | Component test for the page, run with Vitest                         |
| `web/src/lib/`                | Shared client modules, imported as `#lib/...`                        |
| `web/src/vitest-setup.ts`     | Testing Library matchers for component tests                         |
| `web/vitest.config.ts`        | Vitest configuration (jsdom, browser condition)                      |
| `web/src/app.css`             | Tailwind entry point                                                 |
| `server/src/app.ts`           | Hono app: `/health`, `/api/*` and the static SPA fallback            |
| `server/src/app.test.ts`      | API tests run with `bun test`                                        |
| `server/src/index.ts`         | Server entry point; `PORT` selects the listen port                   |
| `scripts/smoke.ts`            | Starts the API and checks `/health`, `/api/hello` and `/` end-to-end |
| `deploy/`                     | Kubernetes manifests applied by the YAAABK deploy Job                |

## Commands

Run these from the repository root.

| Command                         | What it does                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| `bun install --frozen-lockfile` | Install dependencies from the committed lockfile                                   |
| `bun run dev`                   | API and SvelteKit dev servers with hot reload                                      |
| `bun run test`                  | API tests and web-workspace component tests                                        |
| `bun run check`                 | Lint, typecheck, tests, the production build and smoke                             |
| `bun run smoke`                 | Start the API on an ephemeral port, check `/health`, `/api/hello` and `/`, stop it |
| `bun run build`                 | Build `web/build` and the server bundle (also in `check`)                          |
| `bun run start`                 | Run the built server                                                               |

Run `bun run check` before you finish a change; it runs lint, typecheck, tests,
the production build and smoke. YAAABK runs it again after you stop. Run
`bun run smoke` alone only when you need to isolate the runtime check.

YAAABK installs dependencies before the Agent starts. If `node_modules` is
missing, run `bun install --frozen-lockfile` first.

## Testing

- API tests live in `server/src/app.test.ts` and run with `bun:test` through
  `bun run test`.
- Component tests use Vitest, jsdom and Testing Library. Add tests as
  `web/src/**/*.test.ts` next to the code they cover; `page.test.ts` shows how
  to render a page and stub `fetch` with `vi.stubGlobal`.
- Add or update a test whenever an Issue changes observable behaviour. The
  component setup already gives you `toHaveTextContent` and the other jest-dom
  matchers.

## Constraints

- **Accepted Plans are binding.** Accepted Plans live in `docs/plans/`, and the
  version named by the Issue is binding even when a later Plan exists.
- **Use `#lib/...` for shared client modules.** SvelteKit 3 removed the implicit
  `$lib` alias; `web/package.json` maps `#lib/` to `web/src/lib/` as a
  [subpath import](https://svelte.dev/docs/kit/$lib).
- **No browser.** Do not start a browser, install Playwright or Chromium, or
  take screenshots. `bun run smoke` is the end-to-end check for the API and the
  server wiring.
- **Never commit `.yaaabk/`.** It is gitignored. A review Agent writes its
  verdict to `.yaaabk/review.json`; every other Agent leaves the directory
  alone.
- **Keep changes focused.** Implement the Issue and nothing else, and match the
  surrounding code's structure, naming and style.
- **There is no pre-commit hook.** `bun run check` is the single definition of
  the project's checks; do not look for or install a hook.
