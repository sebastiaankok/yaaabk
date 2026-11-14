import { describe, expect, it, vi } from 'vitest';
import { createK8sClient } from './client';
import { apiError, type K8sLogger } from './errors';
import { createInMemoryObjectApi } from './in-memory-object-api';
import type { K8sObject, ObjectApi } from './object-api';

const silentLogger: K8sLogger = { info: () => {}, error: () => {} };

/** An ObjectApi that fails loudly: any call means the cluster was touched. */
function forbiddenObjectApi(): ObjectApi {
  const forbidden = (): never => {
    throw new Error('ObjectApi must not be called');
  };
  return {
    create: forbidden,
    read: forbidden,
    list: forbidden,
    patch: forbidden,
    delete: forbidden,
    watch: forbidden,
  };
}

describe('createK8sClient in dry-run mode', () => {
  it('logs the intended operation and returns a synthetic result without touching the cluster', async () => {
    const info = vi.fn();
    const client = createK8sClient({
      dryRun: true,
      objectApi: forbiddenObjectApi(),
      logger: { info, error: vi.fn() },
    });

    const result = await client.namespaces.create('project-a1b2c3d4', {
      labels: { 'yaaabk.io/project-name': 'todo' },
    });

    expect(result).toEqual({
      ok: true,
      value: {
        name: 'project-a1b2c3d4',
        labels: { 'yaaabk.io/project-name': 'todo' },
        phase: 'Active',
      },
    });
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toContain('namespaces.create');
  });
});

describe('audit logging', () => {
  it('logs every operation, including failures', async () => {
    const info = vi.fn();
    const error = vi.fn();
    const client = createK8sClient({
      objectApi: createInMemoryObjectApi(),
      logger: { info, error },
    });

    await client.namespaces.create('project-a');
    await client.namespaces.get('project-missing');

    expect(info).toHaveBeenCalledWith(
      'k8s namespaces.create',
      expect.objectContaining({ name: 'project-a' }),
    );
    expect(error).toHaveBeenCalledWith(
      'k8s namespaces.get failed',
      expect.objectContaining({ name: 'project-missing', kind: 'not-found' }),
    );
  });
});

describe('namespaces.create', () => {
  it('creates the namespace with its labels and reports the result', async () => {
    const client = createK8sClient({ objectApi: createInMemoryObjectApi(), logger: silentLogger });

    const result = await client.namespaces.create('project-a1b2c3d4', {
      labels: { 'yaaabk.io/project-name': 'todo' },
    });

    expect(result).toEqual({
      ok: true,
      value: {
        name: 'project-a1b2c3d4',
        labels: { 'yaaabk.io/project-name': 'todo' },
        phase: 'Active',
      },
    });
  });
});

/** An in-memory api whose `create` always fails with the given status. */
function createFailingWith(status: number): ObjectApi {
  return {
    ...createInMemoryObjectApi(),
    create: async () => {
      throw apiError(status, 'boom');
    },
  };
}

describe('typed error mapping', () => {
  it.each([
    [403, 'forbidden'],
    [404, 'not-found'],
    [409, 'conflict'],
    [422, 'invalid'],
    [500, 'unknown'],
  ])('maps an HTTP %i response to a %s error', async (status, kind) => {
    const client = createK8sClient({ objectApi: createFailingWith(status), logger: silentLogger });

    const result = await client.namespaces.create('project-a1b2c3d4');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        kind,
        operation: 'namespaces.create',
        message: 'boom',
        statusCode: status,
      });
    }
  });

  it('maps a refused connection to a network error', async () => {
    const objectApi: ObjectApi = {
      ...createInMemoryObjectApi(),
      create: async () => {
        throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), {
          code: 'ECONNREFUSED',
        });
      },
    };
    const client = createK8sClient({ objectApi, logger: silentLogger });

    const result = await client.namespaces.create('project-a1b2c3d4');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('network');
      expect(result.error.operation).toBe('namespaces.create');
    }
  });
});

function namespaceObject(name: string, labels: Record<string, string> = {}): K8sObject {
  return { apiVersion: 'v1', kind: 'Namespace', metadata: { name, labels } };
}

describe('namespaces', () => {
  it('reads back a namespace with its labels and phase', async () => {
    const objectApi = createInMemoryObjectApi([
      {
        ...namespaceObject('project-a1b2c3d4', { team: 'core' }),
        status: { phase: 'Terminating' },
      },
    ]);
    const client = createK8sClient({ objectApi, logger: silentLogger });

    const result = await client.namespaces.get('project-a1b2c3d4');

    expect(result).toEqual({
      ok: true,
      value: { name: 'project-a1b2c3d4', labels: { team: 'core' }, phase: 'Terminating' },
    });
  });

  it('reports a missing namespace as not-found', async () => {
    const client = createK8sClient({ objectApi: createInMemoryObjectApi(), logger: silentLogger });

    const result = await client.namespaces.get('project-missing');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        kind: 'not-found',
        operation: 'namespaces.get',
        message: expect.any(String),
        statusCode: 404,
      });
    }
  });

  it('lists every namespace, optionally filtered by labels', async () => {
    const objectApi = createInMemoryObjectApi([
      namespaceObject('project-a', { 'yaaabk.io/team': 'core' }),
      namespaceObject('project-b', { 'yaaabk.io/team': 'web' }),
    ]);
    const client = createK8sClient({ objectApi, logger: silentLogger });

    const all = await client.namespaces.list();
    const core = await client.namespaces.list({ 'yaaabk.io/team': 'core' });

    expect(all.ok && all.value.map((namespace) => namespace.name)).toEqual([
      'project-a',
      'project-b',
    ]);
    expect(core.ok && core.value.map((namespace) => namespace.name)).toEqual(['project-a']);
  });

  it('adds labels to an existing namespace without dropping the existing ones', async () => {
    const objectApi = createInMemoryObjectApi([namespaceObject('project-a', { team: 'core' })]);
    const client = createK8sClient({ objectApi, logger: silentLogger });

    const result = await client.namespaces.label('project-a', { 'yaaabk.io/project-name': 'todo' });

    expect(result.ok && result.value.labels).toEqual({
      team: 'core',
      'yaaabk.io/project-name': 'todo',
    });
  });

  it('deletes a namespace so it can no longer be read', async () => {
    const objectApi = createInMemoryObjectApi([namespaceObject('project-a')]);
    const client = createK8sClient({ objectApi, logger: silentLogger });

    const deleted = await client.namespaces.delete('project-a');

    expect(deleted).toEqual({ ok: true, value: undefined });
    expect((await client.namespaces.get('project-a')).ok).toBe(false);
  });
});

describe('secrets', () => {
  const secretRef = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 'github-token', namespace: 'project-a' },
  };

  it('stores secret values base64-encoded and reports only their keys', async () => {
    const objectApi = createInMemoryObjectApi();
    const client = createK8sClient({ objectApi, logger: silentLogger });

    const result = await client.secrets.create('project-a', 'github-token', {
      token: 'super-secret',
      username: 'octocat',
    });

    expect(result).toEqual({
      ok: true,
      value: {
        name: 'github-token',
        namespace: 'project-a',
        labels: {},
        keys: ['token', 'username'],
      },
    });
    const stored = await objectApi.read(secretRef);
    expect(stored.data).toEqual({
      token: Buffer.from('super-secret').toString('base64'),
      username: Buffer.from('octocat').toString('base64'),
    });
  });

  it('never exposes secret values when reading a secret back', async () => {
    const objectApi = createInMemoryObjectApi();
    const client = createK8sClient({ objectApi, logger: silentLogger });
    await client.secrets.create('project-a', 'github-token', { token: 'super-secret' });

    const result = await client.secrets.get('project-a', 'github-token');

    expect(result.ok && result.value).toEqual({
      name: 'github-token',
      namespace: 'project-a',
      labels: {},
      keys: ['token'],
    });
    expect(JSON.stringify(result)).not.toContain('super-secret');
  });

  it('reports a missing secret as not-found', async () => {
    const client = createK8sClient({ objectApi: createInMemoryObjectApi(), logger: silentLogger });

    const result = await client.secrets.get('project-a', 'github-token');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('not-found');
      expect(result.error.operation).toBe('secrets.get');
    }
  });

  it('deletes a secret', async () => {
    const objectApi = createInMemoryObjectApi();
    const client = createK8sClient({ objectApi, logger: silentLogger });
    await client.secrets.create('project-a', 'github-token', { token: 'x' });

    expect(await client.secrets.delete('project-a', 'github-token')).toEqual({
      ok: true,
      value: undefined,
    });
    expect((await client.secrets.get('project-a', 'github-token')).ok).toBe(false);
  });
});

describe('service accounts', () => {
  it('creates, reads back and deletes a service account', async () => {
    const client = createK8sClient({ objectApi: createInMemoryObjectApi(), logger: silentLogger });

    const created = await client.serviceAccounts.create('project-a', 'agent-a1b2c3d4');
    expect(created).toEqual({
      ok: true,
      value: { name: 'agent-a1b2c3d4', namespace: 'project-a', labels: {} },
    });

    expect(await client.serviceAccounts.get('project-a', 'agent-a1b2c3d4')).toEqual(created);

    expect(await client.serviceAccounts.delete('project-a', 'agent-a1b2c3d4')).toEqual({
      ok: true,
      value: undefined,
    });
    expect((await client.serviceAccounts.get('project-a', 'agent-a1b2c3d4')).ok).toBe(false);
  });
});

describe('role bindings', () => {
  it('binds a service account to a role and reads the binding back', async () => {
    const client = createK8sClient({ objectApi: createInMemoryObjectApi(), logger: silentLogger });
    const binding = {
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'agent' },
      subjects: [{ kind: 'ServiceAccount', name: 'agent-a1b2c3d4', namespace: 'project-a' }],
    };

    const created = await client.roleBindings.create('project-a', 'agent-a1b2c3d4', binding);

    expect(created).toEqual({
      ok: true,
      value: { name: 'agent-a1b2c3d4', namespace: 'project-a', labels: {}, ...binding },
    });
    expect(await client.roleBindings.get('project-a', 'agent-a1b2c3d4')).toEqual(created);

    expect(await client.roleBindings.delete('project-a', 'agent-a1b2c3d4')).toEqual({
      ok: true,
      value: undefined,
    });
    expect((await client.roleBindings.get('project-a', 'agent-a1b2c3d4')).ok).toBe(false);
  });
});

function jobObject(name: string, extra: Partial<K8sObject> = {}): K8sObject {
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name, namespace: 'project-a', labels: {} },
    ...extra,
  };
}

function jobRef(name: string) {
  return { apiVersion: 'batch/v1', kind: 'Job', metadata: { name, namespace: 'project-a' } };
}

describe('jobs', () => {
  it('builds an agent Job from the spec and reports it as pending', async () => {
    const objectApi = createInMemoryObjectApi();
    const client = createK8sClient({ objectApi, logger: silentLogger });

    const result = await client.jobs.create('project-a', 'agent-42', {
      image: 'yaaabk/agent:1.0.0',
      serviceAccountName: 'agent-a1b2c3d4',
      env: { ISSUE_NUMBER: '42', REPO_URL: 'https://github.com/octocat/todo' },
      backoffLimit: 1,
      resources: {
        requests: { cpu: '500m', memory: '512Mi' },
        limits: { cpu: '1', memory: '1Gi' },
      },
    });

    expect(result).toEqual({
      ok: true,
      value: {
        name: 'agent-42',
        namespace: 'project-a',
        labels: {},
        phase: 'pending',
        active: 0,
        succeeded: 0,
        failed: 0,
      },
    });

    const stored = await objectApi.read(jobRef('agent-42'));
    expect(stored.spec).toEqual({
      backoffLimit: 1,
      template: {
        spec: {
          restartPolicy: 'Never',
          serviceAccountName: 'agent-a1b2c3d4',
          containers: [
            {
              name: 'agent',
              image: 'yaaabk/agent:1.0.0',
              env: [
                { name: 'ISSUE_NUMBER', value: '42' },
                { name: 'REPO_URL', value: 'https://github.com/octocat/todo' },
              ],
              resources: {
                requests: { cpu: '500m', memory: '512Mi' },
                limits: { cpu: '1', memory: '1Gi' },
              },
            },
          ],
        },
      },
    });
  });

  it('mounts a workspace and sources credentials from Secrets without reading them', async () => {
    const objectApi = createInMemoryObjectApi();
    const client = createK8sClient({ objectApi, logger: silentLogger });

    await client.jobs.create('project-a', 'agent-issue-1-attempt-1', {
      image: 'yaaabk/agent:1.0.0',
      env: { ISSUE_NUMBER: '42' },
      envFrom: [
        { secretRef: { name: 'yaaabk-github' } },
        { secretRef: { name: 'agent-openrouter-issue-1' } },
      ],
      volumes: [{ name: 'work', persistentVolumeClaim: { claimName: 'agent-work-issue-1-1' } }],
      volumeMounts: [{ name: 'work', mountPath: '/work' }],
      activeDeadlineSeconds: 1800,
    });

    const stored = await objectApi.read(jobRef('agent-issue-1-attempt-1'));
    const spec = stored.spec as {
      activeDeadlineSeconds: number;
      template: { spec: Record<string, unknown> };
    };
    expect(spec.activeDeadlineSeconds).toBe(1800);
    const container = (spec.template.spec.containers as Array<Record<string, unknown>>)[0];
    expect(container?.envFrom).toEqual([
      { secretRef: { name: 'yaaabk-github' } },
      { secretRef: { name: 'agent-openrouter-issue-1' } },
    ]);
    expect(container?.volumeMounts).toEqual([{ name: 'work', mountPath: '/work' }]);
    expect(spec.template.spec.volumes).toEqual([
      { name: 'work', persistentVolumeClaim: { claimName: 'agent-work-issue-1-1' } },
    ]);
  });

  it('reports a running job while it has active pods', async () => {
    const objectApi = createInMemoryObjectApi([jobObject('agent-42', { status: { active: 1 } })]);
    const client = createK8sClient({ objectApi, logger: silentLogger });

    const result = await client.jobs.get('project-a', 'agent-42');

    expect(result.ok && result.value.phase).toBe('running');
    expect(result.ok && result.value.active).toBe(1);
  });

  it.each([
    ['Complete', 'succeeded'],
    ['Failed', 'failed'],
  ])('reports a %s condition as %s', async (conditionType, phase) => {
    const objectApi = createInMemoryObjectApi([
      jobObject('agent-42', { status: { conditions: [{ type: conditionType, status: 'True' }] } }),
    ]);
    const client = createK8sClient({ objectApi, logger: silentLogger });

    const result = await client.jobs.get('project-a', 'agent-42');

    expect(result.ok && result.value.phase).toBe(phase);
  });

  it('lists jobs filtered by labels', async () => {
    const objectApi = createInMemoryObjectApi([
      {
        ...jobObject('agent-41'),
        metadata: { name: 'agent-41', namespace: 'project-a', labels: { issue: '41' } },
      },
      {
        ...jobObject('agent-42'),
        metadata: { name: 'agent-42', namespace: 'project-a', labels: { issue: '42' } },
      },
    ]);
    const client = createK8sClient({ objectApi, logger: silentLogger });

    const result = await client.jobs.list('project-a', { issue: '42' });

    expect(result.ok && result.value.map((job) => job.name)).toEqual(['agent-42']);
  });

  it('streams job updates and stops once the job reaches a terminal phase', async () => {
    const objectApi = createInMemoryObjectApi([jobObject('agent-42')]);
    const client = createK8sClient({ objectApi, logger: silentLogger });
    const phases: string[] = [];

    const watching = await client.jobs.watch('project-a', 'agent-42', (job) =>
      phases.push(job.phase),
    );
    expect(watching.ok).toBe(true);

    await objectApi.patch({ ...jobRef('agent-42'), status: { active: 1 } });
    await objectApi.patch({
      ...jobRef('agent-42'),
      status: { conditions: [{ type: 'Complete', status: 'True' }] },
    });
    await objectApi.patch({
      ...jobRef('agent-42'),
      status: { conditions: [{ type: 'Failed', status: 'True' }] },
    });

    expect(phases).toEqual(['running', 'succeeded']);
  });

  it('stops streaming when the caller unsubscribes', async () => {
    const objectApi = createInMemoryObjectApi([jobObject('agent-42')]);
    const client = createK8sClient({ objectApi, logger: silentLogger });
    const phases: string[] = [];

    const watching = await client.jobs.watch('project-a', 'agent-42', (job) =>
      phases.push(job.phase),
    );
    if (!watching.ok) {
      throw new Error('watch failed');
    }
    watching.value();

    await objectApi.patch({ ...jobRef('agent-42'), status: { active: 1 } });

    expect(phases).toEqual([]);
  });

  it('deletes a job', async () => {
    const objectApi = createInMemoryObjectApi([jobObject('agent-42')]);
    const client = createK8sClient({ objectApi, logger: silentLogger });

    expect(await client.jobs.delete('project-a', 'agent-42')).toEqual({
      ok: true,
      value: undefined,
    });
    expect((await client.jobs.get('project-a', 'agent-42')).ok).toBe(false);
  });
});

describe('persistent volume claims', () => {
  it('creates a workspace PVC with the requested storage', async () => {
    const objectApi = createInMemoryObjectApi();
    const client = createK8sClient({ objectApi, logger: silentLogger });

    const result = await client.pvcs.create('project-a', 'agent-workspace', {
      storage: '1Gi',
      storageClassName: 'standard',
    });

    expect(result).toEqual({
      ok: true,
      value: {
        name: 'agent-workspace',
        namespace: 'project-a',
        labels: {},
        phase: 'Pending',
        storage: '1Gi',
      },
    });

    const stored = await objectApi.read({
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: { name: 'agent-workspace', namespace: 'project-a' },
    });
    expect(stored.spec).toEqual({
      accessModes: ['ReadWriteOnce'],
      storageClassName: 'standard',
      resources: { requests: { storage: '1Gi' } },
    });
  });

  it('reports the bound phase and storage of an existing PVC', async () => {
    const objectApi = createInMemoryObjectApi([
      {
        apiVersion: 'v1',
        kind: 'PersistentVolumeClaim',
        metadata: { name: 'agent-workspace', namespace: 'project-a' },
        spec: { resources: { requests: { storage: '2Gi' } } },
        status: { phase: 'Bound' },
      },
    ]);
    const client = createK8sClient({ objectApi, logger: silentLogger });

    const result = await client.pvcs.get('project-a', 'agent-workspace');

    expect(result.ok && result.value).toEqual({
      name: 'agent-workspace',
      namespace: 'project-a',
      labels: {},
      phase: 'Bound',
      storage: '2Gi',
    });
  });

  it('deletes a PVC', async () => {
    const objectApi = createInMemoryObjectApi();
    const client = createK8sClient({ objectApi, logger: silentLogger });
    await client.pvcs.create('project-a', 'agent-workspace', { storage: '1Gi' });

    expect(await client.pvcs.delete('project-a', 'agent-workspace')).toEqual({
      ok: true,
      value: undefined,
    });
    expect((await client.pvcs.get('project-a', 'agent-workspace')).ok).toBe(false);
  });
});

describe('argocd applications', () => {
  it('creates an Application that deploys the project repo into its namespace', async () => {
    const objectApi = createInMemoryObjectApi();
    const client = createK8sClient({ objectApi, logger: silentLogger });

    const result = await client.applications.create('project-a', 'todo-app', {
      source: {
        repoURL: 'https://github.com/octocat/todo',
        path: 'deploy',
        targetRevision: 'main',
      },
      destination: { server: 'https://kubernetes.default.svc', namespace: 'project-a' },
      syncPolicy: { automated: { prune: true, selfHeal: true } },
    });

    expect(result).toEqual({
      ok: true,
      value: {
        name: 'todo-app',
        namespace: 'project-a',
        labels: {},
        syncStatus: 'Unknown',
        healthStatus: 'Unknown',
      },
    });

    const stored = await objectApi.read({
      apiVersion: 'argoproj.io/v1alpha1',
      kind: 'Application',
      metadata: { name: 'todo-app', namespace: 'project-a' },
    });
    expect(stored.spec).toEqual({
      project: 'default',
      source: {
        repoURL: 'https://github.com/octocat/todo',
        path: 'deploy',
        targetRevision: 'main',
      },
      destination: { server: 'https://kubernetes.default.svc', namespace: 'project-a' },
      syncPolicy: { automated: { prune: true, selfHeal: true } },
    });
  });

  it('reports the sync and health status of an Application', async () => {
    const objectApi = createInMemoryObjectApi([
      {
        apiVersion: 'argoproj.io/v1alpha1',
        kind: 'Application',
        metadata: { name: 'todo-app', namespace: 'project-a' },
        status: { sync: { status: 'Synced' }, health: { status: 'Healthy' } },
      },
    ]);
    const client = createK8sClient({ objectApi, logger: silentLogger });

    const result = await client.applications.get('project-a', 'todo-app');

    expect(result.ok && result.value).toEqual({
      name: 'todo-app',
      namespace: 'project-a',
      labels: {},
      syncStatus: 'Synced',
      healthStatus: 'Healthy',
    });
  });

  it('deletes an Application', async () => {
    const objectApi = createInMemoryObjectApi();
    const client = createK8sClient({ objectApi, logger: silentLogger });
    await client.applications.create('project-a', 'todo-app', {
      source: { repoURL: 'https://github.com/octocat/todo', path: 'deploy' },
      destination: { namespace: 'project-a' },
    });

    expect(await client.applications.delete('project-a', 'todo-app')).toEqual({
      ok: true,
      value: undefined,
    });
    expect((await client.applications.get('project-a', 'todo-app')).ok).toBe(false);
  });
});
