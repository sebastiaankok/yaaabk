import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTemplateModule } from './template';
import type { TemplateProject } from './types';

const exec = promisify(execFile);
const FIXTURE = fileURLToPath(new URL('./__fixtures__/template', import.meta.url));

const PROJECT: TemplateProject = {
  id: 'a1b2c3d4-1111-4111-8111-111111111111',
  name: 'todo-app',
  repoUrl: '',
};

const silent = { info: () => {}, error: () => {} };

/** Bare git requires no network, so this exercises the real adapter in CI. */
let hasGit = true;
beforeAll(async () => {
  hasGit = await exec('git', ['--version']).then(
    () => true,
    () => false,
  );
});

const roots: string[] = [];
async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'yaaabk-git-test-'));
  roots.push(root);
  return root;
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe.skipIf(!hasGit)('createGitBackend', () => {
  it('pushes a scaffold with fresh history to a bare remote', async () => {
    const root = await makeRoot();
    const remote = join(root, 'remote.git');
    await exec('git', ['init', '--bare', '--initial-branch=main', remote]);

    const module = createTemplateModule({
      source: { type: 'directory', path: FIXTURE },
      workDir: root,
      logger: silent,
    });

    const result = await module.scaffold({ ...PROJECT, repoUrl: `file://${remote}` });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const clone = join(root, 'clone');
    await exec('git', ['clone', `file://${remote}`, clone]);

    const pkg = JSON.parse(await readFile(join(clone, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('todo-app');

    const { stdout: log } = await exec('git', ['-C', clone, 'log', '--oneline']);
    expect(log.trim().split('\n')).toHaveLength(1);
    expect(log).toContain('chore: scaffold todo-app from the YAAABK template');
  });

  it('reports an unreachable remote as push-failed', async () => {
    const root = await makeRoot();
    const module = createTemplateModule({
      source: { type: 'directory', path: FIXTURE },
      workDir: root,
      logger: silent,
    });

    const result = await module.scaffold({
      ...PROJECT,
      repoUrl: `file://${join(root, 'does-not-exist.git')}`,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('push-failed');
  });
});
