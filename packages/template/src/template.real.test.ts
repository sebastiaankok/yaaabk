import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultTemplateSource } from './config';
import { createFakeGitBackend } from './fake-git-backend';
import { createTemplateModule } from './template';
import type { TemplateProject } from './types';

/**
 * Exercises the module against the real `templates/svelte-bun` on disk, so a
 * template file that forgets a token (or leaves one behind) fails here.
 */

const PROJECT: TemplateProject = {
  id: 'a1b2c3d4-1111-4111-8111-111111111111',
  name: 'todo-app',
  repoUrl: 'git@github.com:acme/todo-app.git',
};

const silent = { info: () => {}, error: () => {} };
const TOKENS = ['projectName', 'projectId', 'namespace', 'repoUrl', 'port', 'argoAppName'];

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeWorkDir(): Promise<string> {
  const workDir = await mkdtemp(join(tmpdir(), 'yaaabk-real-template-'));
  cleanup.push(workDir);
  return workDir;
}

describe('scaffold against the bundled svelte-bun template', () => {
  it('resolves the default source to the in-repo template directory', () => {
    const source = defaultTemplateSource();

    expect(source).toMatchObject({ type: 'directory' });
    if (source.type !== 'directory') return;
    expect(isAbsolute(source.path)).toBe(true);
    expect(source.path.endsWith(join('templates', 'svelte-bun'))).toBe(true);
  });

  it('renders every template file and leaves no project token behind', async () => {
    const workDir = await makeWorkDir();
    const git = createFakeGitBackend();
    const module = createTemplateModule({ git, workDir, logger: silent });

    const result = await module.scaffold(PROJECT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { directory, files } = result.value;

    for (const relative of [
      'Dockerfile',
      'deploy/argo-app.yaml',
      'deploy/deployment.yaml',
      '.github/workflows/ci.yml',
      'server/src/app.ts',
      'web/src/routes/+page.svelte',
    ]) {
      expect(files).toContain(relative);
    }

    for (const relative of files) {
      const contents = await readFile(join(directory, relative), 'utf8').catch(() => '');
      for (const token of TOKENS) {
        expect(contents, `${relative} still contains {{${token}}}`).not.toContain(`{{${token}}}`);
      }
    }
  });

  it('interpolates the values the template and deploy manifests rely on', async () => {
    const workDir = await makeWorkDir();
    const module = createTemplateModule({
      git: createFakeGitBackend(),
      workDir,
      logger: silent,
    });

    const result = await module.scaffold(PROJECT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { directory } = result.value;

    const rootPkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    expect(rootPkg.name).toBe('todo-app');
    expect(rootPkg.scripts.build).toContain('@todo-app/web');

    const argo = await readFile(join(directory, 'deploy/argo-app.yaml'), 'utf8');
    expect(argo).toContain('name: todo-app');
    expect(argo).toContain('repoURL: git@github.com:acme/todo-app.git');
    expect(argo).toContain('namespace: project-a1b2c3d4');

    const deployment = await readFile(join(directory, 'deploy/deployment.yaml'), 'utf8');
    expect(deployment).toContain('containerPort: 3000');

    const page = await readFile(join(directory, 'web/src/routes/+page.svelte'), 'utf8');
    expect(page).toContain('todo-app');

    // GitHub Actions expressions must survive interpolation untouched.
    const ci = await readFile(join(directory, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('${{ github.ref }}');
  });
});
