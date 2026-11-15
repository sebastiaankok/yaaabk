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
  githubToken?: string | null;
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
      namespace: 'project-a1b2c3d4',
      argoAppName: 'todo-app',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });

    expect(store.getByName('todo-app')).toEqual(project);

    // YAAABK no longer provisions the Project namespace or agent identity;
    // ArgoCD deploys the scaffold, whose Namespace manifest creates it.
    expect((await k8s.namespaces.get(project.namespace)).ok).toBe(false);
    expect((await k8s.serviceAccounts.get(project.namespace, 'yaaabk-agent')).ok).toBe(false);
    expect((await k8s.roleBindings.get(project.namespace, 'yaaabk-agent')).ok).toBe(false);
    expect((await k8s.secrets.get(project.namespace, 'yaaabk-github')).ok).toBe(false);

    // The Application lives in the ArgoCD apps namespace and defers to the
    // shared AppProject, which YAAABK does not create or modify.
    const application = await k8s.applications.get('yaaabk-apps', 'todo-app');
    expect(application.ok).toBe(true);

    const argoProject = await k8s.argoProjects.get('yaaabk');
    expect(argoProject.ok).toBe(false);

    const storedApplication = await k8s.objectApi.read({
      apiVersion: 'argoproj.io/v1alpha1',
      kind: 'Application',
      metadata: { name: 'todo-app', namespace: 'yaaabk-apps' },
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
      'argocd:started',
      'argocd:completed',
      'persist:started',
      'persist:completed',
    ]);
  });

  it('rolls back created resources when a later step fails', async () => {
    const { module, store, k8s, repositories } = harness({
      seed: [existingApplication('todo-app', 'yaaabk-apps')],
    });

    const result = await module.create(INPUT);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('kubernetes');
    expect(store.list()).toHaveLength(0);
    expect((await k8s.applications.get('yaaabk-apps', 'todo-app')).ok).toBe(true);
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
      metadata: { name: 'todo-app', namespace: 'yaaabk-apps' },
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
  it('tears down the repository and ArgoCD Application, then forgets the project', async () => {
    const { module, store, k8s, repositories } = harness();
    const created = await module.create(INPUT);
    if (!created.ok) throw new Error('create failed');

    const result = await module.remove(created.value.id);

    expect(result.ok).toBe(true);
    expect(store.get(created.value.id)).toBeUndefined();
    // Deleting the Application lets ArgoCD prune the scaffold, which includes
    // the Project namespace manifest; YAAABK itself deletes nothing else.
    expect((await k8s.applications.get('yaaabk-apps', created.value.argoAppName)).ok).toBe(false);
    expect(repositories.calls).toContainEqual({ op: 'delete', fullName: 'acme/todo-app' });
  });

  it('tolerates resources that are already gone', async () => {
    const { module, k8s } = harness();
    const created = await module.create(INPUT);
    if (!created.ok) throw new Error('create failed');
    await k8s.applications.delete('yaaabk-apps', created.value.argoAppName);

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
