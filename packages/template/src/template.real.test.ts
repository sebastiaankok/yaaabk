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
const TOKENS = [
  'projectName',
  'projectId',
  'namespace',
  'repoUrl',
  'repoOwner',
  'repoName',
  'imageRepository',
  'repoWebUrl',
  'baseImage',
  'port',
];

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
      'bun.lock',
      'deploy/httproute.yaml',
      'deploy/deployment.yaml',
      '.github/workflows/ci.yml',
      'server/src/app.ts',
      'web/src/routes/+page.svelte',
    ]) {
      expect(files).toContain(relative);
    }
    // The Namespace is provisioned by the backend and Ingress is replaced by HTTPRoute.
    expect(files).not.toContain('deploy/namespace.yaml');
    expect(files).not.toContain('deploy/ingress.yaml');
    expect(files).not.toContain('deploy/argo-app.yaml');

    for (const relative of files) {
      const contents = await readFile(join(directory, relative), 'utf8').catch(() => '');
      for (const token of TOKENS) {
        expect(contents, `${relative} still contains {{${token}}}`).not.toContain(`{{${token}}}`);
      }
    }
  });

  it('scaffolds at the repository root when YAAABK_TEMPLATE_DIR points at a template', async () => {
    // A deployment sets YAAABK_TEMPLATE_DIR; it must name the template
    // directory itself. Pointing it at the parent (the directory *holding*
    // svelte-bun) used to nest every file under `svelte-bun/`, leaving the
    // repository with no `deploy/` at the root for the deploy Job to apply.
    const source = defaultTemplateSource();
    if (source.type !== 'directory') throw new Error('the default source is a directory');
    const workDir = await makeWorkDir();
    const module = createTemplateModule({
      git: createFakeGitBackend(),
      workDir,
      source: { type: 'directory', path: source.path },
      logger: silent,
    });

    const result = await module.scaffold(PROJECT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.files).toContain('deploy/deployment.yaml');
    expect(result.value.files).not.toContain('svelte-bun/deploy/deployment.yaml');
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

    const httprouteManifest = await readFile(join(directory, 'deploy/httproute.yaml'), 'utf8');
    expect(httprouteManifest).toContain('kind: HTTPRoute');
    expect(httprouteManifest).toContain('name: todo-app');
    expect(httprouteManifest).toContain('namespace: yaaabk-a1b2c3d4');
    expect(httprouteManifest).toContain('name: internal');

    const deployment = await readFile(join(directory, 'deploy/deployment.yaml'), 'utf8');
    expect(deployment).toContain('containerPort: 3000');
    expect(deployment).toContain('image: ghcr.io/acme/todo-app:latest');
    expect(deployment).not.toContain('your-org');

    const dockerfile = await readFile(join(directory, 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('ARG BASE_IMAGE=oven/bun:1.3-alpine');
    expect(dockerfile).toContain(
      'org.opencontainers.image.source="https://github.com/acme/todo-app"',
    );
    expect(dockerfile).toContain('bun install --frozen-lockfile');

    const page = await readFile(join(directory, 'web/src/routes/+page.svelte'), 'utf8');
    expect(page).toContain('todo-app');

    // GitHub Actions expressions must survive interpolation untouched.
    const ci = await readFile(join(directory, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('${{ github.ref }}');
    expect(ci).not.toContain('git commit -am');
  });
});
