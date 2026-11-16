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
# The shared AppProject is cluster-scoped and applied separately:
kubectl --context k3s-home apply -f deploy/appproject.yaml
```

## Deploy a release

`scripts/deploy.sh` builds the backend, frontend and agent images for
`linux/amd64`, pushes them to `ghcr.io`, and rolls them out:

```sh
scripts/deploy.sh 0.1.1
```

The tag is required, so a rollout is always deliberate. `SKIP_BUILD=1` re-applies
the manifests and pins an already-pushed tag; `KUBE_CONTEXT` overrides the
kubeconfig context. The script injects the tag at apply time, so the `0.1.0`
values in `deploy/*.yaml` are a local baseline, not the running version.

## Verify

```sh
kubectl --context k3s-home -n yaaabk get pods,svc,httproute
curl https://yaaabk.otohgunga.nl/health
# Verify backend permissions:
kubectl --context k3s-home auth can-i --list \
  --as=system:serviceaccount:yaaabk:yaaabk-backend
```

## Notes

- The backend talks to the cluster in-cluster as ServiceAccount
  `yaaabk-backend` with two namespaced RoleBindings in `yaaabk` (one for agent
  Jobs, PVCs and per-attempt Secrets, one for ArgoCD Applications) and two
  narrow cluster-scoped Roles: `yaaabk-backend-namespaces` (`create`, `get`,
  `delete` on Namespaces) and `yaaabk-backend-rbac` (`create`, `get`, `list`,
  `watch`, `patch`, `delete` on ServiceAccounts, Roles, and RoleBindings in
  Project Namespaces).
- Agent Jobs report back to `http://yaaabk-backend.yaaabk.svc.cluster.local:3000`
  (cluster-internal); browsers use `https://yaaabk.otohgunga.nl`.
- SQLite lives on the `yaaabk-data` PVC (`local-path`, node-local, 1Gi).
  Single backend replica, `Recreate` strategy — a lost node means lost data.
- **GitHub credentials**: prefer a GitHub App (Settings page: app id, private
  key, installation id — all three are required). Grant it **Administration:
  read/write** plus Contents, Issues, Pull requests, **Workflows** and Metadata;
  Workflows is needed because every Project ships a CI workflow, and GitHub
  rejects the first scaffold push for an App without it. The backend mints
  short-lived installation tokens for repository management, scaffold pushes and
  agent runs — no long-lived PAT is used or copied around. The PAT/env fallbacks
  exist only for local dev. Note that registering an App is not installing it:
  create one at <https://github.com/settings/apps>, install it on the `yaaabk`
  org, then copy the installation id from the install confirmation URL into
  Settings. Until then every create fails with "configured without an
  Installation ID", and `YAAABK_GITHUB_OWNER` must still name the account repos
  are created under (`yaaabk`).
- **ArgoCD**: each Project Application is created in `yaaabk`, not in
  `argocd`. Applications outside ArgoCD's own namespace are only reconciled
  when two things agree:
  1. `application.namespaces` in `argocd-cmd-params-cm` includes `yaaabk`
     (then restart `argocd-server` and `argocd-application-controller`);
  2. the `yaaabk` AppProject's `spec.sourceNamespaces` includes `yaaabk`
     (applied from `appproject.yaml`).

  Without both, ArgoCD refuses the Application as a permission violation and it
  sits unreconciled with an empty status — which looks like a successful create.
  The controller must also read the project repositories — replace any
  PAT-based repository credential with a GitHub App installation token secret
  in the `argocd` namespace.
