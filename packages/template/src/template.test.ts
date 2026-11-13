import { readFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeGitBackend, type FakeGitBackend } from './fake-git-backend';
import type { TemplateSource } from './git-backend';
import { createTemplateModule, type TemplateModuleOptions } from './template';
import type { TemplateProject } from './types';

const FIXTURE = fileURLToPath(new URL('./__fixtures__/template', import.meta.url));
const PROJECT_ID = 'a1b2c3d4-1111-4111-8111-111111111111';

const PROJECT: TemplateProject = {
  id: PROJECT_ID,
  name: 'todo-app',
  repoUrl: 'git@github.com:acme/todo-app.git',
};

const silent = { info: () => {}, error: () => {} };

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeWorkDir(): Promise<string> {
  const workDir = await mkdtemp(join(tmpdir(), 'yaaabk-template-test-'));
  cleanup.push(workDir);
  return workDir;
}

/** Scaffolds `project` with a fake backend whose template is the fixture. */
async function scaffoldFixture(
  overrides: Partial<TemplateModuleOptions> = {},
): Promise<{ module: ReturnType<typeof createTemplateModule>; git: FakeGitBackend }> {
  const workDir = await makeWorkDir();
  const git = createFakeGitBackend();
  const module = createTemplateModule({
    git,
    source: { type: 'directory', path: FIXTURE } satisfies TemplateSource,
    workDir,
    logger: silent,
    ...overrides,
  });
  return { module, git };
}

describe('scaffold', () => {
  it('materialises the template into a new repository and pushes it', async () => {
    const { module, git } = await scaffoldFixture();

    const result = await module.scaffold(PROJECT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(git.calls.map((call) => call.op)).toEqual(['fetch', 'init', 'commit', 'push']);
    expect(result.value).toMatchObject({
      name: 'todo-app',
      repoUrl: PROJECT.repoUrl,
      branch: 'main',
    });

    const readme = await readFile(join(result.value.directory, 'README.md'), 'utf8');
    expect(readme).toContain('# todo-app');
    expect(readme).toContain('Namespace: project-a1b2c3d4');

    const pkg = JSON.parse(await readFile(join(result.value.directory, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('todo-app');
  });

  it('interpolates every project value across nested files', async () => {
    const { module } = await scaffoldFixture();

    const result = await module.scaffold(PROJECT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const config = await readFile(join(result.value.directory, 'deploy/configmap.yaml'), 'utf8');
    expect(config).toContain('name: todo-app-config');
    expect(config).toContain('namespace: project-a1b2c3d4');
    expect(config).toContain("PORT: '3000'");
    expect(config).toContain(`PROJECT_ID: '${PROJECT_ID}'`);

    expect(result.value.files).toEqual([
      'README.md',
      'assets/logo.bin',
      'deploy/configmap.yaml',
      'notes.md',
      'package.json',
    ]);
  });

  it('leaves unknown tokens and binary files untouched', async () => {
    const { module } = await scaffoldFixture();

    const result = await module.scaffold(PROJECT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const notes = await readFile(join(result.value.directory, 'notes.md'), 'utf8');
    expect(notes).toContain('{{notAProjectToken}}');
    expect(notes).toContain(`Project id: ${PROJECT_ID}`);

    const binary = await readFile(join(result.value.directory, 'assets/logo.bin'));
    const original = await readFile(join(FIXTURE, 'assets/logo.bin'));
    expect(binary.equals(original)).toBe(true);
  });
});

describe('scaffold error handling', () => {
  it.each(['Todo App', 'todo_app', '-todo', 'todo-', 'todo--app', 'a'.repeat(40)])(
    'rejects the invalid project name %j without touching git',
    async (name) => {
      const { module, git } = await scaffoldFixture();

      const result = await module.scaffold({ ...PROJECT, name });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('invalid-project');
      expect(result.error.operation).toBe('scaffold');
      expect(git.calls).toEqual([]);
    },
  );

  it('rejects a repository URL that is not a git remote', async () => {
    const { module, git } = await scaffoldFixture();

    const result = await module.scaffold({ ...PROJECT, repoUrl: 'not a url' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-project');
    expect(git.calls).toEqual([]);
  });

  it('reports a missing template as missing-template', async () => {
    const workDir = await makeWorkDir();
    const git = createFakeGitBackend();
    const module = createTemplateModule({
      git,
      source: { type: 'git', url: 'https://github.com/yaaabk/template-svelte-bun.git' },
      workDir,
      logger: silent,
    });

    const result = await module.scaffold(PROJECT);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ kind: 'missing-template', operation: 'scaffold' });
    expect(git.calls.map((call) => call.op)).toEqual(['fetch']);
  });

  it('reports a rejected push as push-failed', async () => {
    const workDir = await makeWorkDir();
    const git = createFakeGitBackend({
      pushError: 'remote: Permission to acme/todo-app.git denied',
    });
    const module = createTemplateModule({
      git,
      source: { type: 'directory', path: FIXTURE } satisfies TemplateSource,
      workDir,
      logger: silent,
    });

    const result = await module.scaffold(PROJECT);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('push-failed');
    expect(result.error.message).toContain('Permission');
    expect(git.calls.map((call) => call.op)).toEqual(['fetch', 'init', 'commit', 'push']);
  });
});

describe('scaffold git details', () => {
  it('interpolates the port and ArgoCD name, and pushes the requested branch', async () => {
    const { module, git } = await scaffoldFixture();

    const result = await module.scaffold({
      ...PROJECT,
      port: 8080,
      argoAppName: 'todo',
      branch: 'scaffold/init',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.branch).toBe('scaffold/init');

    const readme = await readFile(join(result.value.directory, 'README.md'), 'utf8');
    expect(readme).toContain('API port: 8080');
    expect(readme).toContain('ArgoCD application: todo');

    const push = git.calls.find((call) => call.op === 'push');
    expect(push).toMatchObject({ url: PROJECT.repoUrl, branch: 'scaffold/init' });
  });

  it('commits every file with the configured author', async () => {
    const { module, git } = await scaffoldFixture({
      author: { name: 'Scaffolder', email: 'scaffolder@example.com' },
    });

    const result = await module.scaffold(PROJECT);

    expect(result.ok).toBe(true);
    const commit = git.calls.find((call) => call.op === 'commit');
    expect(commit).toMatchObject({
      message: 'chore: scaffold todo-app from the YAAABK template',
      author: { name: 'Scaffolder', email: 'scaffolder@example.com' },
    });
  });
});

describe('scaffold dry-run', () => {
  it('previews the files without creating a repository or pushing', async () => {
    const info = vi.fn();
    const { module, git } = await scaffoldFixture({
      dryRun: true,
      logger: { info, error: vi.fn() },
    });

    const result = await module.scaffold(PROJECT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(git.calls.map((call) => call.op)).toEqual(['fetch']);
    expect(result.value.files).toContain('deploy/configmap.yaml');
    expect(info).toHaveBeenCalledWith(
      'template scaffold',
      expect.objectContaining({ name: 'todo-app' }),
    );
  });
});

describe('scaffold logging', () => {
  it('logs a failed scaffold with its typed kind', async () => {
    const error = vi.fn();
    const { module } = await scaffoldFixture({ logger: { info: vi.fn(), error } });

    await module.scaffold({ ...PROJECT, name: 'Bad Name' });

    expect(error).toHaveBeenCalledWith(
      'template scaffold failed',
      expect.objectContaining({ kind: 'invalid-project' }),
    );
  });
});
