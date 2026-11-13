# YAAABK — Yet Another AI App Builder for Kubernetes

An AI-native Internal Developer Platform that takes a developer from idea to
deployed application on Kubernetes: brainstorm in an AI-driven grill-me session,
turn the refined plan into GitHub issues, and let autonomous agents implement
them.

- Product requirements: [`PRD.md`](./PRD.md)
- Implementation plan and architecture: [`PLAN.md`](./PLAN.md)
- Domain language: [`CONTEXT.md`](./CONTEXT.md)

## Requirements

- [Bun](https://bun.sh) **1.3+** (the only runtime needed for development)
- Docker, only if you want the containerised stack (optional)

## Quick start

```sh
bun install
bun run dev
```

Open <http://localhost:5173> for the web UI and <http://localhost:3000/health>
for the backend health check.

## Repository layout

This is a Bun workspace monorepo:

| Package | Path | What it is |
| --- | --- | --- |
| `@yaaabk/frontend` | `packages/frontend` | SvelteKit + Tailwind + shadcn-svelte browser UI |
| `@yaaabk/backend` | `packages/backend` | Bun + Hono REST API and SSE bridge |
| `@yaaabk/agent` | `packages/agent` | Per-issue agent that runs in a Kubernetes Job |
| `@yaaabk/shared` | `packages/shared` | Types and constants shared across packages |

Internal packages export TypeScript source directly and are bundled by their
consumers, so there is no separate compile step for `shared`.

## Scripts

Run these from the repository root; each fans out across the workspace.

| Command | Description |
| --- | --- |
| `bun run dev` | Start the frontend and backend dev servers together |
| `bun run build` | Build every package |
| `bun run test` | Run all unit tests (Vitest) |
| `bun run test:e2e` | Run the Playwright end-to-end tests for the frontend |
| `bun run typecheck` | Typecheck every package |
| `bun run lint` | Lint the whole repo with ESLint |
| `bun run format` | Format with Prettier |
| `bun run format:check` | Check formatting without writing |

To work on a single package, run its scripts directly, e.g.
`bun run --filter '@yaaabk/backend' test:unit`.

## Testing

- **Unit tests** live beside the code as `*.test.ts` / `*.spec.ts` and run with
  [Vitest](https://vitest.dev). Tests exercise public behaviour through each
  module's interface.
- **End-to-end tests** live as `*.e2e.ts` and run with
  [Playwright](https://playwright.dev). They boot the SvelteKit dev server
  automatically. Install browsers once with
  `bunx playwright install chromium`.

## Containerised stack (optional)

```sh
docker compose up --build
```

This builds the backend and frontend images and mounts a named volume for the
SQLite data directory. The OpenCode sidecar is added in a later slice.

## CI

`.github/workflows/ci.yml` runs on every push to `main` and on pull requests:
format check, lint, typecheck, unit tests, build, and end-to-end tests.
