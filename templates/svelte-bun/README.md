# {{projectName}}

An application scaffolded by [YAAABK](https://github.com) from the
`svelte-bun` template: a SvelteKit single-page app served by a Bun + Hono API.

- Project id: `{{projectId}}`
- Kubernetes namespace: `{{namespace}}`
- ArgoCD application: `{{argoAppName}}`
- API port: `{{port}}`

## Layout

| Path      | What it is                                               |
| --------- | -------------------------------------------------------- |
| `web/`    | SvelteKit + Tailwind single-page app                     |
| `server/` | Bun + Hono API that also serves `web/build`              |
| `deploy/` | Kubernetes manifests, including the ArgoCD `Application` |

## Developing locally

```sh
bun install
bun run dev   # API on :{{port}}, web dev server on :5173
```

## Checks

```sh
bun run typecheck
bun test
bun run build
```

## Deploying

`deploy/deployment.yaml` references an image from a container registry. Replace
`ghcr.io/your-org/{{projectName}}` with your registry, then let ArgoCD sync the
`deploy/` directory into the `{{namespace}}` namespace. CI builds and pushes a
new image tag on every push to `main` and commits the updated manifest.
