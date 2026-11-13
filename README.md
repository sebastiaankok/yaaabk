# YAAABK — Yet Another AI App Builder for Kubernetes

An AI-native Internal Developer Platform that takes a developer from idea to
deployed application on Kubernetes: brainstorm in an AI-driven grill-me session,
turn the refined plan into GitHub issues, and let autonomous agents implement
them.

- Product requirements: [`PRD.md`](./PRD.md)
- Implementation plan and architecture: [`PLAN.md`](./PLAN.md)
- Domain language: [`CONTEXT.md`](./CONTEXT.md)

## Requirements

- [Bun](https://bun.sh) **1.3+** — the only runtime needed for local development
- Docker — optional, only for the containerised stack

## Developing locally

```sh
git clone <repo-url> yaaabk
cd yaaabk
bun install   # installs every workspace package
bun run dev   # starts the frontend and backend together
```

`bun run dev` runs both servers with live reload; `Ctrl-C` stops both.

| Service | URL | What you should see |
| --- | --- | --- |
| Frontend | <http://localhost:5173> | The YAAABK landing page |
| Backend | <http://localhost:3000> | `GET /health` → `{"status":"ok"}`, `GET /api/skill-levels` |

No configuration is needed to start. To change defaults, copy the example file
to the repository root:

```sh
cp .env.example .env
```

| Variable | Default | Used by |
| --- | --- | --- |
| `PORT` | `3000` | Backend HTTP port |
| `YAAABK_DATA_DIR` | `./data` | Reserved for the SQLite database file |
| `PUBLIC_API_BASE_URL` | `http://localhost:3000` | Frontend → backend base URL |

A single root `.env` configures every package: the backend loads it via
`--env-file`, and Vite loads it via `envDir`. Only variables prefixed with
`PUBLIC_` are exposed to browser code. You can also override a value for one
command without editing the file, e.g. `PORT=4000 bun run dev`.

To work on one package at a time:

```sh
bun run --filter '@yaaabk/backend' dev    # backend only
bun run --filter '@yaaabk/frontend' dev   # frontend only
```

## Repository layout

This is a Bun workspace monorepo:

| Package | Path | What it is |
| --- | --- | --- |
| `@yaaabk/frontend` | `packages/frontend` | SvelteKit + Tailwind + shadcn-svelte browser UI |
| `@yaaabk/backend` | `packages/backend` | Bun + Hono REST API and SSE bridge |
| `@yaaabk/agent` | `packages/agent` | Per-issue agent that runs in a Kubernetes Job |
| `@yaaabk/k8s` | `packages/k8s` | Typed Kubernetes client (`createK8sClient`) and in-memory mock |
| `@yaaabk/template` | `packages/template` | Project scaffolder (`scaffold(project)`) with an injectable git backend |
| `@yaaabk/shared` | `packages/shared` | Types and constants shared across packages |

Project templates live in [`templates/`](./templates). `@yaaabk/template` copies
the bundled [`templates/svelte-bun`](./templates/svelte-bun) — a SvelteKit +
Tailwind app served by a Bun + Hono API, with Docker, Kubernetes, ArgoCD and CI
wiring — interpolates the project's values, and pushes the result to the new
project repository.

Internal packages export TypeScript source directly and are bundled by their
consumers, so there is no separate compile step for `shared`.

## Scripts

Run these from the repository root; each fans out across the workspace.

| Command | Description |
| --- | --- |
| `bun run dev` | Start the frontend and backend dev servers together |
| `bun run build` | Build every package |
| `bun run test` | Run all unit tests (Vitest) |
| `bun run test:e2e:install` | Download the Playwright browser (once per machine) |
| `bun run test:e2e` | Run the Playwright end-to-end tests |
| `bun run typecheck` | Typecheck every package |
| `bun run lint` | Lint the whole repo with ESLint |
| `bun run format` | Format with Prettier |
| `bun run format:check` | Check formatting without writing |

To run a single package's script, use `--filter`, e.g.
`bun run --filter '@yaaabk/backend' test:unit`.

## Testing

Unit tests are fast and need no setup:

```sh
bun run test
```

End-to-end tests drive a real browser against the SvelteKit dev server
(booted automatically by Playwright). Install the browser once, then run them:

```sh
bun run test:e2e:install
bun run test:e2e
```

- **Unit tests** live beside the code as `*.test.ts` / `*.spec.ts` and run with
  [Vitest](https://vitest.dev). Tests exercise public behaviour through each
  module's interface.
- **End-to-end tests** live as `*.e2e.ts` and run with
  [Playwright](https://playwright.dev).
- **Kubernetes integration tests** (`@yaaabk/k8s`) are skipped by default and
  need a real cluster. Point them at a kind or minikube kubeconfig and run:

  ```sh
  bun run --filter '@yaaabk/k8s' test:integration
  ```

## Production build

```sh
bun run build                                   # build every package
bun run --filter '@yaaabk/frontend' preview     # serve the built frontend
```

The frontend build must run through Bun (`@sveltejs/adapter-bun`), which the
package scripts already handle.

## Containerised stack (optional)

```sh
docker compose up --build
```

This builds the backend and frontend images, exposes the frontend on
<http://localhost:5173>, and mounts a named volume for the SQLite data
directory. The OpenCode sidecar is added in a later slice.

## CI

`.github/workflows/ci.yml` runs on every push to `main` and on pull requests:
format check, lint, typecheck, unit tests, build, and end-to-end tests.
