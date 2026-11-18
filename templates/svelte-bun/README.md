# {{projectName}}

An application scaffolded by [YAAABK](https://github.com) from the
`svelte-bun` template: a SvelteKit single-page app served by a Bun + Hono API.

- Project id: `{{projectId}}`
- Kubernetes namespace: `{{namespace}}`
- API port: `{{port}}`

## Layout

| Path      | What it is                                            |
| --------- | ----------------------------------------------------- |
| `web/`    | SvelteKit + Tailwind single-page app                  |
| `server/` | Bun + Hono API that also serves `web/build`           |
| `deploy/` | Kubernetes manifests applied by the YAAABK deploy Job |

## Developing locally

```sh
bun install
bun run dev   # API on :{{port}}, web dev server on :5173
```

## Checks

```sh
bun run check   # lint, typecheck and tests
bun run build
```

`bun.lock` is committed, so CI and the YAAABK agent install with
`bun install --frozen-lockfile`.

## Deploying

After your pull request passes CI and review and is merged, YAAABK automatically
spawns a deploy Job in `{{namespace}}` that applies `deploy/` with server-side
apply, waits for the rollout, and verifies the `/health` endpoint.
