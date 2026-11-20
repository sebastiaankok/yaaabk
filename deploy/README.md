# Deploying YAAABK

Targets the `k3s-home` cluster (kubeconfig `~/.kube/configs/k3s.yaml`, context
`k3s-home`), namespace `yaaabk`.

## Prerequisites

1. **Images** — `ghcr.io/sebastiaankok/yaaabk-{backend,frontend,agent}:0.1.0`,
   built for `linux/amd64` (the node is amd64; a stock Apple Silicon Docker
   daemon builds arm64 unless `--platform` is passed):

   ```sh
   docker buildx build --platform linux/amd64 \
     --target runtime \
     -f packages/backend/Dockerfile \
     -t ghcr.io/sebastiaankok/yaaabk-backend:0.1.0 --push .
   docker buildx build --platform linux/amd64 \
     -f packages/frontend/Dockerfile \
     -t ghcr.io/sebastiaankok/yaaabk-frontend:0.1.0 --push .
   docker buildx build --platform linux/amd64 \
     -f packages/agent/Dockerfile \
     -t ghcr.io/sebastiaankok/yaaabk-agent:0.1.0 --push .
   ```

   Deployments use the backend's `runtime` stage; the `dev` stage (with ttyd
   and OpenCode) exists only for `docker compose`.

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

## Deploy a release

`scripts/deploy.sh` builds the backend, frontend and agent images for
`linux/amd64`, pushes them to `ghcr.io`, and rolls them out:

```sh
cat deploy/VERSION            # 0.1.42 — the last release
scripts/deploy.sh 0.1.43      # bump the patch
```

`deploy/VERSION` is written by the script after a successful rollout, so it
names the release that is actually running and never advances on a failed
deploy. Commit it with the release. Re-applying the same tag is allowed (a
retry); deploying an older tag warns, since that is usually a rollback.

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
  `yaaabk-backend` with four narrow cluster-scoped ClusterRoles of its own:
  - `yaaabk-backend-namespaces` (`create`, `get`, `list`, `delete` on
    Namespaces; `list` lets session reconciliation find leftover Pods after a
    backend restart)
  - `yaaabk-backend-rbac` (`create`, `get`, `list`, `watch`, `patch`, `delete`
    on ServiceAccounts and RoleBindings in Project Namespaces, plus `bind` on
    only the `yaaabk-project-agent` and `yaaabk-project-deploy` ClusterRoles)
  - `yaaabk-backend-agent` (`create`, `get`, `list`, `watch`, `patch`, `delete`
    on Secrets, PVCs, and Jobs across Project Namespaces).
  - `yaaabk-backend-sessions` (`create`, `get`, `list`, `watch`, `delete` on
    Pods and NetworkPolicies across Project Namespaces). Session Secrets reuse
    the `yaaabk-backend-agent` grant.
- Grill-Me Sessions run as one Pod per session in the Project's Namespace under
  its `yaaabk-agent` ServiceAccount, with Pod Security `restricted` and explicit
  CPU and memory limits. An init container clones the Project repository with a
  short-lived `contents:read` GitHub token; that Secret is never mounted into
  the main container, which runs ttyd in front of a tmux-supervised
  `opencode mini` in `/workspace/repo`. tmux keeps the agent alive when the
  backend's terminal client disconnects, so a reconnect resumes the same
  conversation.
  A per-session NetworkPolicy admits the backend pod only and permits egress to
  the backend, HTTPS for GitHub/OpenRouter and the Kubernetes API (ports 443 and
  6443, because kube-proxy DNATs the API Service to a control-plane node before
  egress policy is evaluated), and DNS. `YAAABK_SESSION_RUNTIME=kubernetes`
  selects the adapter; `YAAABK_SESSION_IMAGE` must name the shared agent image.
- Per-Project permissions live in the fixed `yaaabk-project-agent` and
  `yaaabk-project-deploy` ClusterRoles. Project creation only creates the
  ServiceAccounts and a RoleBinding to each, so the backend never needs to hold
  (or mint) the permissions it delegates — Kubernetes rejects a Role granting
  permissions its creator does not have.
- Agent Jobs, their PVCs, and their per-run Secrets run inside each Project's
  own Namespace (`yaaabk-<short-uuid>`) under the Project's
  `yaaabk-agent` ServiceAccount. Kubernetes mounts an auto-rotating
  ServiceAccount token into each Job, and `kubectl` is included in the agent
  image so Agents can debug their Project's workloads without any long-lived
  credential.
- Deploy Jobs run inside each Project's Namespace (`yaaabk-<short-uuid>`) under
  the Project's `yaaabk-deploy` ServiceAccount with an ephemeral `emptyDir`
  working volume and a `contents:read` GitHub token Secret. They cannot create
  or delete Namespaces.
- Agent and deploy Jobs, and a session's reporting MCP server, report back to
  `http://yaaabk-backend.yaaabk.svc.cluster.local` (the Service's port 80; the
  container's 3000 is not reachable through the ClusterIP)
  (cluster-internal); browsers use `https://yaaabk.otohgunga.nl`.
- SQLite lives on the `yaaabk-data` PVC (`local-path`, node-local, 1Gi).
  Single backend replica, `Recreate` strategy — a lost node means lost data.
- **GitHub credentials**: prefer a GitHub App (Settings page: app id, private
  key, installation id — all three are required). Grant it **Administration:
  read/write** plus Contents, Issues, Pull requests, **Workflows** and Metadata;
  Workflows is needed because every Project ships a CI workflow, and GitHub
  rejects the first scaffold push for an App without it. The backend mints
  short-lived installation tokens for repository management, scaffold pushes and
  agent/deploy runs — no long-lived PAT is used or copied around. The PAT/env
  fallbacks exist only for local dev. Note that registering an App is not
  installing it: create one at <https://github.com/settings/apps>, install it on
  the `yaaabk` org, then copy the installation id from the install confirmation
  URL into Settings. Until then every create fails with "configured without an
  Installation ID", and `YAAABK_GITHUB_OWNER` must still name the account repos
  are created under (`yaaabk`).
- **Project images (GHCR)**: each Project's CI publishes
  `ghcr.io/<owner>/<repo>:<commit-sha>`, and the deploy Job pins the Deployment
  to exactly that tag. YAAABK creates Project repositories **public**, so the
  first workflow-created package inherits public visibility and the cluster can
  pull it anonymously. GitHub has no API for changing package visibility: if a
  package was created while its repository was private, set it public in the
  package settings by hand. A workflow can push a new package (it then inherits
  the repository's Actions access), but a package that already exists — for
  example from a previous Project with the same name — needs the repository
  added under **Manage Actions access** with role **Write**. There is no REST
  or GraphQL API for that setting either. If a Project is deleted and recreated
  under the same name, delete the old package first, or the new repository will
  keep getting a 403.
- **YAAABK images**: `.github/workflows/publish-images.yml` builds the
  backend, frontend, agent and optional Svelte/Bun base images on GitHub's
  runners with the Actions layer cache. It needs the same package access for
  `yaaabk-backend`, `yaaabk-frontend`, `yaaabk-agent` and
  `yaaabk-svelte-bun-base`; the local `scripts/deploy.sh` remains the fallback.
  Set `YAAABK_TEMPLATE_BASE_IMAGE` to the published base image to make project
  Docker builds start with dependencies installed.
