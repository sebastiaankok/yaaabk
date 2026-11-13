# @yaaabk/k8s

The K8s Client Module: a thin, typed wrapper around `@kubernetes/client-node`
that exposes only the cluster operations YAAABK needs. No other module talks to
the Kubernetes API directly.

## Usage

```ts
import { createK8sClient } from '@yaaabk/k8s';

const k8s = createK8sClient();

const created = await k8s.namespaces.create('project-a1b2c3d4', {
  labels: { 'yaaabk.io/project-name': 'todo' },
});
if (!created.ok) {
  // created.error.kind is 'conflict' | 'not-found' | 'forbidden' | 'network' | ...
}
```

Every operation resolves to a `K8sResult` — `{ ok: true, value }` or
`{ ok: false, error }` — so callers branch on `ok` instead of catching
exceptions. Nothing throws across the module boundary.

Supported resources: Namespaces, Secrets, ServiceAccounts, RoleBindings, Jobs
(including status watch), PersistentVolumeClaims, and ArgoCD `Application`
custom resources.

### Configuration

`createK8sClient()` auto-detects where it is running:

- inside a pod (`KUBERNETES_SERVICE_HOST` set) it uses the in-cluster config;
- otherwise it resolves the standard kubeconfig, honouring `KUBECONFIG`.

Pass `connection` to override the detection.

### Dry-run

```ts
const k8s = createK8sClient({ dryRun: true });
```

Every call is logged and returns a synthetic result; the cluster is never
touched. Useful for rehearsing a project bootstrap.

### Mock client

Other modules should test against `createMockK8sClient()` rather than stubbing
individual methods. It behaves like a real API server for the operations
YAAABK uses — including conflict and not-found responses — and lets tests seed
starting state:

```ts
import { createMockK8sClient } from '@yaaabk/k8s';

const k8s = createMockK8sClient({ seed: [existingNamespace] });
```

## Tests

```sh
bun run test:unit          # fast, in-memory; no cluster required
bun run test:integration   # needs a real kind/minikube kubeconfig
```

The integration suite is skipped unless `YAAABK_K8S_INTEGRATION=1` (set by the
`test:integration` script). It needs a reachable kubeconfig and creates and
deletes a `yaaabk-it-*` namespace. The ArgoCD case additionally requires the
`Application` CRD and `YAAABK_K8S_INTEGRATION_ARGOCD=1`.
