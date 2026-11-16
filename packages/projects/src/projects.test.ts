import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockK8sClient, KINDS, type K8sObject, type MockK8sClient } from '@yaaabk/k8s';
import { createFakeGitBackend, createTemplateModule, silentLogger } from '@yaaabk/template';
import type { FakeGitBackend } from '@yaaabk/template';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createFakeRepositoryProvider,
  type FakeRepositoryProvider,
} from './fake-repository-provider';
import {
  PROJECT_AGENT_SERVICE_ACCOUNT,
  PROJECT_DEPLOY_SERVICE_ACCOUNT,
  PROJECT_NAME_LABEL,
  PROJECT_PSA_LABELS,
} from './config';
import { createInMemoryProjectStore } from './in-memory-project-store';
import { createProjectsModule, type ProjectsModule } from './projects';
import type { ProvisioningEvent, ProjectStore } from './types';

const PROJECT_ID = 'a1b2c3d4-1111-4111-8111-111111111111';
const NOW = new Date('2026-01-01T12:00:00.000Z');

const INPUT = { name: 'todo-app', description: 'A todo list', skillLevel: 'expert' } as const;

interface Harness {
  module: ProjectsModule;
  store: ProjectStore;
  k8s: MockK8sClient;
  repositories: FakeRepositoryProvider;
  git: FakeGitBackend;
  clock: { now: Date };
}

interface HarnessOverrides {
  /** Objects the in-memory cluster starts with, e.g. to force a conflict. */
  seed?: K8sObject[];
  /** Overrides the GitHub token; `null` omits it entirely. */
  githubToken?: string | null | (() => Promise<string | undefined>);
  /** Project ids handed out by successive `create` calls. */
  ids?: string[];
}

/**
 * Wires the real Projects Module over an in-memory store, an in-memory cluster,
 * a fake repository provider and the real Template Module backed by a fake git
 * backend on a tiny on-disk fixture.
 */
function harness(overrides: HarnessOverrides = {}): Harness {
  const store = createInMemoryProjectStore();
  const k8s = createMockK8sClient({ seed: overrides.seed ?? [] });
  const repositories = createFakeRepositoryProvider();
  const git = createFakeGitBackend();
  const templates = createTemplateModule({
    git,
    source: { type: 'directory', path: templateDir },
    workDir,
    logger: silentLogger,
  });

  const clock = { now: NOW };
  const ids = overrides.ids ?? [PROJECT_ID];
  let next = 0;

  const token = overrides.githubToken === undefined ? 'gh-token' : overrides.githubToken;

  const module = createProjectsModule({
    store,
    k8s,
    templates,
    repositories,
    ...(token === null ? {} : { githubToken: token }),
    ids: () => ids[next++] ?? PROJECT_ID,
    clock: () => clock.now,
    logger: silentLogger,
  });

  return { module, store, k8s, repositories, git, clock };
}

/** A cluster object that already occupies an Application's name. */
function existingApplication(name: string, namespace: string): K8sObject {
  return { ...KINDS.application, metadata: { name, namespace }, spec: {} };
}

let templateDir: string;
let workDir: string;

beforeEach(async () => {
  templateDir = await mkdtemp(join(tmpdir(), 'yaaabk-projects-template-'));
  workDir = await mkdtemp(join(tmpdir(), 'yaaabk-projects-work-'));
  await writeFile(join(templateDir, 'README.md'), '# {{projectName}}\n\nPort {{port}}.\n');
});

afterEach(async () => {
  await rm(templateDir, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
});

describe('create', () => {
  it('provisions the repository and cluster resources, then records the project', async () => {
    const { module, store, k8s, git } = harness();

    const result = await module.create({
      name: 'todo-app',
      description: 'A todo list',
      skillLevel: 'expert',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const project = result.value;

    expect(project).toMatchObject({
      id: PROJECT_ID,
      name: 'todo-app',
      description: 'A todo list',
      skillLevel: 'expert',
      repoFullName: 'acme/todo-app',
      repoUrl: 'https://github.com/acme/todo-app',
      namespace: 'yaaabk-a1b2c3d4',
      argoAppName: 'todo-app',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });

    expect(store.getByName('todo-app')).toEqual(project);

    // YAAABK provisions the Project namespace, PSA labels, and per-Project RBAC
    // (yaaabk-agent and yaaabk-deploy SAs, Roles, and RoleBindings).
    const ns = await k8s.namespaces.get(project.namespace);
    expect(ns.ok).toBe(true);
    if (ns.ok) {
      expect(ns.value.labels).toMatchObject({
        [PROJECT_NAME_LABEL]: 'todo-app',
        ...PROJECT_PSA_LABELS,
      });
    }

    for (const saName of [PROJECT_AGENT_SERVICE_ACCOUNT, PROJECT_DEPLOY_SERVICE_ACCOUNT]) {
      const sa = await k8s.serviceAccounts.get(project.namespace, saName);
      expect(sa.ok).toBe(true);
      if (sa.ok) {
        expect(sa.value).toMatchObject({ name: saName, namespace: project.namespace });
      }

      const role = await k8s.roles.get(project.namespace, saName);
      expect(role.ok).toBe(true);
      if (role.ok) {
        expect(role.value).toMatchObject({ name: saName, namespace: project.namespace });
      }

      const rb = await k8s.roleBindings.get(project.namespace, saName);
      expect(rb.ok).toBe(true);
      if (rb.ok) {
        expect(rb.value).toMatchObject({
          name: saName,
          namespace: project.namespace,
          roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: saName },
          subjects: [{ kind: 'ServiceAccount', name: saName, namespace: project.namespace }],
        });
      }
    }

    const agentRole = await k8s.roles.get(project.namespace, PROJECT_AGENT_SERVICE_ACCOUNT);
    expect(agentRole.ok).toBe(true);
    if (agentRole.ok) {
      const readCore = agentRole.value.rules.find((r) => r.resources.includes('pods'));
      expect(readCore).toMatchObject({
        apiGroups: [''],
        resources: expect.arrayContaining(['pods', 'pods/log', 'services', 'configmaps', 'events']),
        verbs: ['get', 'list', 'watch'],
      });
      expect(readCore?.resources).not.toContain('secrets');
      expect(agentRole.value.rules.find((r) => r.resources.includes('pods/exec'))).toMatchObject({
        apiGroups: [''],
        resources: ['pods/exec'],
        verbs: ['create'],
      });
      expect(agentRole.value.rules.find((r) => r.resources.includes('deployments'))).toMatchObject({
        apiGroups: ['apps'],
        resources: ['deployments'],
        verbs: ['get', 'list', 'watch'],
      });
      expect(agentRole.value.rules.find((r) => r.resources.includes('httproutes'))).toMatchObject({
        apiGroups: ['gateway.networking.k8s.io'],
        resources: ['httproutes'],
        verbs: ['get', 'list', 'watch'],
      });
    }

    const deployRole = await k8s.roles.get(project.namespace, PROJECT_DEPLOY_SERVICE_ACCOUNT);
    expect(deployRole.ok).toBe(true);
    if (deployRole.ok) {
      const writeVerbs = ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'];
      const coreWrite = deployRole.value.rules.find((r) => r.resources.includes('services'));
      expect(coreWrite).toMatchObject({
        apiGroups: [''],
        resources: expect.arrayContaining(['services', 'configmaps', 'secrets']),
        verbs: writeVerbs,
      });
      expect(deployRole.value.rules.find((r) => r.resources.includes('deployments'))).toMatchObject(
        {
          apiGroups: ['apps'],
          resources: ['deployments'],
          verbs: writeVerbs,
        },
      );
      expect(deployRole.value.rules.find((r) => r.resources.includes('httproutes'))).toMatchObject({
        apiGroups: ['gateway.networking.k8s.io'],
        resources: ['httproutes'],
        verbs: writeVerbs,
      });
      expect(deployRole.value.rules.find((r) => r.resources.includes('pods'))).toMatchObject({
        apiGroups: [''],
        resources: ['pods', 'pods/log'],
        verbs: ['get', 'list'],
      });
      expect(deployRole.value.rules.some((r) => r.resources.includes('namespaces'))).toBe(false);
    }

    // The Application lives in `yaaabk` beside the backend and defers to the
    // shared AppProject, which YAAABK does not create or modify.
    const application = await k8s.applications.get('yaaabk', 'todo-app');
    expect(application.ok).toBe(true);

    const argoProject = await k8s.argoProjects.get('yaaabk');
    expect(argoProject.ok).toBe(false);

    const storedApplication = await k8s.objectApi.read({
      apiVersion: 'argoproj.io/v1alpha1',
      kind: 'Application',
      metadata: { name: 'todo-app', namespace: 'yaaabk' },
    });
    expect(storedApplication.spec).toMatchObject({ project: 'yaaabk' });

    expect(git.calls).toContainEqual({
      op: 'push',
      directory: expect.any(String),
      url: 'https://github.com/acme/todo-app.git',
      branch: 'main',
      // The scaffold authenticates its HTTPS push with the same credential.
      token: 'gh-token',
    });
  });

  it('resolves the scaffold token per create rather than snapshotting it', async () => {
    const tokens = ['first-token', 'second-token'];
    const { module, git } = harness({
      githubToken: () => Promise.resolve(tokens.shift()),
      ids: ['aaaaaaaa-1111', 'bbbbbbbb-2222'],
    });

    await module.create(INPUT);
    await module.create({ ...INPUT, name: 'todo-app-2' });

    const pushTokens = git.calls
      .filter((call) => call.op === 'push')
      .map((call) => (call.op === 'push' ? call.token : undefined));
    expect(pushTokens).toEqual(['first-token', 'second-token']);
  });

  it('rejects an invalid project without touching any external system', async () => {
    const { module, store, repositories, git } = harness();

    const result = await module.create({ ...INPUT, name: 'Not Valid' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-input');
    expect(repositories.calls).toHaveLength(0);
    expect(git.calls).toHaveLength(0);
    expect(store.list()).toHaveLength(0);
  });

  it('rejects a duplicate name without touching any external system', async () => {
    const { module, store, repositories } = harness();
    await module.create(INPUT);
    const callsAfterFirst = repositories.calls.length;

    const result = await module.create(INPUT);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('duplicate-name');
    expect(repositories.calls).toHaveLength(callsAfterFirst);
    expect(store.list()).toHaveLength(1);
  });

  it('emits provisioning progress in order', async () => {
    const { module } = harness();
    const events: ProvisioningEvent[] = [];

    await module.create(INPUT, { onProgress: (event) => events.push(event) });

    expect(events.map((event) => `${event.step}:${event.status}`)).toEqual([
      'repository:started',
      'repository:completed',
      'scaffold:started',
      'scaffold:completed',
      'namespace:started',
      'namespace:completed',
      'rbac:started',
      'rbac:completed',
      'argocd:started',
      'argocd:completed',
      'persist:started',
      'persist:completed',
    ]);
  });

  it('rolls back created resources when a later step fails', async () => {
    const { module, store, k8s, repositories } = harness({
      seed: [existingApplication('todo-app', 'yaaabk')],
    });

    const result = await module.create(INPUT);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('kubernetes');
    expect(store.list()).toHaveLength(0);
    expect((await k8s.applications.get('yaaabk', 'todo-app')).ok).toBe(true);
    expect((await k8s.namespaces.get('yaaabk-a1b2c3d4')).ok).toBe(false);
    expect(repositories.calls).toContainEqual({ op: 'delete', fullName: 'acme/todo-app' });
  });

  it('rolls back the repository when namespace creation fails', async () => {
    const { module, store, repositories } = harness({
      seed: [
        {
          apiVersion: 'v1',
          kind: 'Namespace',
          metadata: { name: 'yaaabk-a1b2c3d4', labels: {} },
        },
      ],
    });

    const result = await module.create(INPUT);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('kubernetes');
    expect(store.list()).toHaveLength(0);
    expect(repositories.calls).toContainEqual({ op: 'delete', fullName: 'acme/todo-app' });
  });
});

describe('list', () => {
  it('returns every project', async () => {
    const { module } = harness({
      ids: [PROJECT_ID, 'b1b2c3d4-1111-4111-8111-111111111111'],
    });
    await module.create(INPUT);
    await module.create({ ...INPUT, name: 'notes-app' });

    const result = await module.list();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((project) => project.name).sort()).toEqual(['notes-app', 'todo-app']);
  });
});

describe('get', () => {
  it('returns a project by id', async () => {
    const { module } = harness();
    const created = await module.create(INPUT);
    if (!created.ok) throw new Error('create failed');

    const result = await module.get(created.value.id);

    expect(result.ok && result.value).toEqual(created.value);
  });

  it('reports not-found for an unknown id', async () => {
    const { module } = harness();

    const result = await module.get('missing');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('not-found');
  });
});

describe('update', () => {
  it('updates the description and skill level, bumping updatedAt', async () => {
    const { module, store, clock } = harness();
    const created = await module.create(INPUT);
    if (!created.ok) throw new Error('create failed');
    clock.now = new Date('2026-02-01T00:00:00.000Z');

    const result = await module.update(created.value.id, {
      description: 'Updated',
      skillLevel: 'beginner',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      description: 'Updated',
      skillLevel: 'beginner',
      updatedAt: '2026-02-01T00:00:00.000Z',
    });
    expect(store.get(created.value.id)?.description).toBe('Updated');
  });

  it('rejects an empty description', async () => {
    const { module } = harness();
    const created = await module.create(INPUT);
    if (!created.ok) throw new Error('create failed');

    const result = await module.update(created.value.id, { description: '   ' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-input');
  });

  it('reports not-found for an unknown id', async () => {
    const { module } = harness();

    const result = await module.update('missing', { description: 'Updated' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('not-found');
  });
});

describe('export', () => {
  it('transfers the repository and repoints the ArgoCD Application', async () => {
    const { module, store, k8s, repositories, clock } = harness();
    const created = await module.create(INPUT);
    if (!created.ok) throw new Error('create failed');
    clock.now = new Date('2026-02-01T00:00:00.000Z');

    const result = await module.export(created.value.id, { owner: 'dev', repoName: 'todo' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      repoFullName: 'dev/todo',
      repoUrl: 'https://github.com/dev/todo',
      updatedAt: '2026-02-01T00:00:00.000Z',
    });
    expect(store.get(created.value.id)).toEqual(result.value);

    expect(repositories.calls).toContainEqual({
      op: 'add-collaborator',
      fullName: 'acme/todo-app',
      username: 'dev',
    });
    expect(repositories.calls).toContainEqual({
      op: 'transfer',
      fullName: 'acme/todo-app',
      newOwner: 'dev',
      repoName: 'todo',
    });

    const storedApplication = await k8s.objectApi.read({
      apiVersion: 'argoproj.io/v1alpha1',
      kind: 'Application',
      metadata: { name: 'todo-app', namespace: 'yaaabk' },
    });
    expect(storedApplication.spec).toMatchObject({
      source: { repoURL: 'https://github.com/dev/todo' },
    });
  });

  it('defaults the target repo name to the project name', async () => {
    const { module, repositories } = harness();
    const created = await module.create(INPUT);
    if (!created.ok) throw new Error('create failed');

    const result = await module.export(created.value.id, { owner: 'dev' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.repoFullName).toBe('dev/todo-app');
    expect(repositories.calls).toContainEqual({
      op: 'transfer',
      fullName: 'acme/todo-app',
      newOwner: 'dev',
      repoName: 'todo-app',
    });
  });

  it('reports not-found for an unknown id', async () => {
    const { module } = harness();

    const result = await module.export('missing', { owner: 'dev' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('not-found');
  });

  it('rejects an invalid owner without touching the repository', async () => {
    const { module, repositories } = harness();
    const created = await module.create(INPUT);
    if (!created.ok) throw new Error('create failed');

    const result = await module.export(created.value.id, { owner: 'Dev_O!' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-input');
    expect(repositories.calls).toHaveLength(1); // only the original create
  });
});

describe('remove', () => {
  it('tears down the repository, ArgoCD Application, and Namespace, then forgets the project', async () => {
    const { module, store, k8s, repositories } = harness();
    const created = await module.create(INPUT);
    if (!created.ok) throw new Error('create failed');

    const result = await module.remove(created.value.id);

    expect(result.ok).toBe(true);
    expect(store.get(created.value.id)).toBeUndefined();
    expect((await k8s.applications.get('yaaabk', created.value.argoAppName)).ok).toBe(false);
    expect((await k8s.namespaces.get(created.value.namespace)).ok).toBe(false);
    expect(repositories.calls).toContainEqual({ op: 'delete', fullName: 'acme/todo-app' });
  });

  it('tolerates resources that are already gone', async () => {
    const { module, k8s } = harness();
    const created = await module.create(INPUT);
    if (!created.ok) throw new Error('create failed');
    await k8s.applications.delete('yaaabk', created.value.argoAppName);

    const result = await module.remove(created.value.id);

    expect(result.ok).toBe(true);
  });

  it('reports not-found for an unknown id', async () => {
    const { module } = harness();

    const result = await module.remove('missing');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('not-found');
  });
});
