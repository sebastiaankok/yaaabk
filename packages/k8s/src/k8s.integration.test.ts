import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createK8sClient } from './client';
import type { JobInfo, K8sResult } from './types';

/**
 * Exercises every operation against a real cluster. Skipped by default; run it
 * with `bun run test:integration` against a kind or minikube cluster whose
 * kubeconfig is reachable.
 *
 * The ArgoCD case additionally needs the Application CRD installed; set
 * `YAAABK_K8S_INTEGRATION_ARGOCD=1` once ArgoCD is present.
 */
const enabled = process.env.YAAABK_K8S_INTEGRATION === '1';
const argoEnabled = process.env.YAAABK_K8S_INTEGRATION_ARGOCD === '1';

const namespace = `yaaabk-it-${Date.now().toString(36)}`;
const k8s = createK8sClient({ connection: { mode: 'kubeconfig' } });

async function watchUntilTerminal(jobName: string): Promise<JobInfo> {
  return new Promise<JobInfo>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`job ${jobName} did not finish in time`)),
      90_000,
    );
    void k8s.jobs.watch(namespace, jobName, (job) => {
      if (job.phase === 'succeeded' || job.phase === 'failed') {
        clearTimeout(timeout);
        resolve(job);
      }
    });
  });
}

describe.skipIf(!enabled)('K8s Client against a real cluster', () => {
  beforeAll(async () => {
    const created = await k8s.namespaces.create(namespace, {
      labels: { 'yaaabk.io/test': 'integration' },
    });
    expect(created.ok).toBe(true);
  });

  afterAll(async () => {
    await k8s.namespaces.delete(namespace);
  });

  it('reads back the namespace it just created', async () => {
    const result = await k8s.namespaces.get(namespace);

    expect(result.ok && result.value.name).toBe(namespace);
    expect(result.ok && result.value.labels['yaaabk.io/test']).toBe('integration');
  });

  it('reports a missing namespace as a typed not-found error', async () => {
    const result = await k8s.namespaces.get(`${namespace}-missing`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('not-found');
      expect(result.error.statusCode).toBe(404);
    }
  });

  it('stores a secret and reads back only its keys', async () => {
    const created = await k8s.secrets.create(namespace, 'github-token', {
      token: 'integration-secret',
    });

    expect(created).toEqual({
      ok: true,
      value: { name: 'github-token', namespace, labels: {}, keys: ['token'] },
    });
    const fetched = await k8s.secrets.get(namespace, 'github-token');
    expect(fetched.ok && fetched.value.keys).toEqual(['token']);
    expect(JSON.stringify(fetched)).not.toContain('integration-secret');
  });

  it('creates a service account and binds it to a role', async () => {
    const account = await k8s.serviceAccounts.create(namespace, 'agent');
    expect(account.ok).toBe(true);

    const binding = await k8s.roleBindings.create(namespace, 'agent', {
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'agent' },
      subjects: [{ kind: 'ServiceAccount', name: 'agent', namespace }],
    });

    expect(binding.ok && binding.value.subjects).toEqual([
      { kind: 'ServiceAccount', name: 'agent', namespace },
    ]);
  });

  it('creates a persistent volume claim', async () => {
    const result = await k8s.pvcs.create(namespace, 'agent-workspace', { storage: '1Gi' });

    expect(result.ok && result.value.storage).toBe('1Gi');
    expect(['Pending', 'Bound']).toContain(result.ok ? result.value.phase : '');
  });

  it('runs a Job to completion and watches it', async () => {
    const created = await k8s.jobs.create(namespace, 'agent-it', {
      image: 'busybox:1.36',
      command: ['sh', '-c', 'echo hello from yaaabk'],
      backoffLimit: 0,
    });
    expect(created.ok).toBe(true);

    const finished = await watchUntilTerminal('agent-it');

    expect(finished.phase).toBe('succeeded');
    expect(finished.succeeded).toBe(1);
  });

  it.skipIf(!argoEnabled)('creates an ArgoCD Application', async () => {
    const result = await k8s.applications.create(namespace, 'it-app', {
      source: {
        repoURL: 'https://github.com/yaaabk/template-svelte-bun',
        path: 'deploy',
        targetRevision: 'main',
      },
      destination: { namespace },
    });

    expect(result.ok).toBe(true);
  });

  it('reports a conflict when a namespace already exists', async () => {
    const result: K8sResult<unknown> = await k8s.namespaces.create(namespace);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('conflict');
    }
  });
});
