# Deploying YAAABK

Targets the `k3s-home` cluster (kubeconfig `~/.kube/configs/k3s.yaml`, context
`k3s-home`), namespace `yaaabk`.

## Prerequisites

1. **Images** — `ghcr.io/sebastiaankok/yaaabk-{backend,frontend,agent}:0.1.0`,
   built for `linux/amd64` (the node is amd64; a stock Apple Silicon Docker
   daemon builds arm64 unless `--platform` is passed):

   ```sh
   docker buildx build --platform linux/amd64 \
     -f packages/backend/Dockerfile \
     -t ghcr.io/sebastiaankok/yaaabk-backend:0.1.0 --push .
   docker buildx build --platform linux/amd64 \
     -f packages/frontend/Dockerfile \
     -t ghcr.io/sebastiaankok/yaaabk-frontend:0.1.0 --push .
   docker buildx build --platform linux/amd64 \
     -f packages/agent/Dockerfile \
     -t ghcr.io/sebastiaankok/yaaabk-agent:0.1.0 --push .
   ```

   The frontend's `PUBLIC_API_BASE_URL` is read from the server process env at
   startup (SvelteKit resolves `$app/env/public` at runtime; the deploy value
   lives in `deploy/frontend.yaml`), so changing the hostname does not require
   rebuilding the frontend image.

2. **Secret** — created out of band; values never enter git:

   ```sh
   kubectl --context k3s-home -n yaaabk create secret generic yaaabk-env \
     --from-literal=YAAABK_AUTH_SECRET="$(openssl rand -base64 48)"
   # Optional credential fallbacks (the Settings page is preferred):
   #   --from-literal=YAAABK_GITHUB_TOKEN=...
   #   --from-literal=YAAABK_GITHUB_OWNER=...
   #   --from-literal=OPENROUTER_MANAGEMENT_KEY=...
   ```

3. **DNS** — `yaaabk.otohgunga.nl` resolves to the `internal` Gateway address
   (`10.10.21.50`), same wildcard as the other apps.

## Apply

```sh
kubectl --context k3s-home apply -k deploy
```

## Verify

```sh
kubectl --context k3s-home -n yaaabk get pods,svc,httproute
curl https://yaaabk.otohgunga.nl/health
```

## Notes

- The backend talks to the cluster in-cluster (ServiceAccount
  `yaaabk-backend`, ClusterRole `yaaabk-backend`): it creates the per-Project
  Namespaces, Secrets, ServiceAccounts and RoleBindings, spawns Agent Jobs,
  and creates ArgoCD Applications.
- Agent Jobs report back to `http://yaaabk-backend.yaaabk.svc.cluster.local:3000`
  (cluster-internal); browsers use `https://yaaabk.otohgunga.nl`.
- SQLite lives on the `yaaabk-data` PVC (`local-path`, node-local, 1Gi).
  Single backend replica, `Recreate` strategy — a lost node means lost data.
