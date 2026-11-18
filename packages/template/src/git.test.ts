import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTemplateModule } from './template';
import { cleanGitEnv, explainPushFailure } from './git';
import type { TemplateProject } from './types';

const exec = promisify(execFile);
const FIXTURE = fileURLToPath(new URL('./__fixtures__/template', import.meta.url));

/**
 * Runs git with a clean environment.
 *
 * The suite itself can run from a git hook, which exports GIT_DIR and
 * GIT_INDEX_FILE for the repository the commit is happening in; without this
 * the test's own `clone` and `log` would target that repository.
 */
function runGit(args: string[]) {
  return exec('git', args, { env: cleanGitEnv() });
}

const PROJECT: TemplateProject = {
  id: 'a1b2c3d4-1111-4111-8111-111111111111',
  name: 'todo-app',
  repoUrl: '',
};

const silent = { info: () => {}, error: () => {} };

/** Bare git requires no network, so this exercises the real adapter in CI. */
let hasGit = true;
beforeAll(async () => {
  hasGit = await runGit(['--version']).then(
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
    await runGit(['init', '--bare', '--initial-branch=main', remote]);

    const module = createTemplateModule({
      source: { type: 'directory', path: FIXTURE },
      workDir: root,
      logger: silent,
    });

    const result = await module.scaffold({ ...PROJECT, repoUrl: `file://${remote}` });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const clone = join(root, 'clone');
    await runGit(['clone', `file://${remote}`, clone]);

    const pkg = JSON.parse(await readFile(join(clone, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('todo-app');

    const { stdout: log } = await runGit(['-C', clone, 'log', '--oneline']);
    expect(log.trim().split('\n')).toHaveLength(1);
    expect(log).toContain('chore: scaffold todo-app from the YAAABK template');
  });

  it('ignores a repository the calling environment pins git to', async () => {
    const root = await makeRoot();
    const remote = join(root, 'remote.git');
    await runGit(['init', '--bare', '--initial-branch=main', remote]);

    const module = createTemplateModule({
      source: { type: 'directory', path: FIXTURE },
      workDir: root,
      logger: silent,
    });

    // What a git hook exports. Inherited, these win over `-C` and would make
    // the scaffold commit into the caller's repository instead of its own.
    const savedDir = process.env.GIT_DIR;
    const savedIndex = process.env.GIT_INDEX_FILE;
    process.env.GIT_DIR = join(root, 'not-a-repository');
    process.env.GIT_INDEX_FILE = join(root, 'not-an-index');
    try {
      const result = await module.scaffold({ ...PROJECT, repoUrl: `file://${remote}` });
      expect(result.ok).toBe(true);
    } finally {
      if (savedDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = savedDir;
      if (savedIndex === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = savedIndex;
    }

    const clone = join(root, 'inherit-clone');
    await runGit(['clone', `file://${remote}`, clone]);
    const pkg = JSON.parse(await readFile(join(clone, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('todo-app');
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

describe('explainPushFailure', () => {
  const GITHUB_WORKFLOWS_REFUSAL =
    'remote: refusing to allow a GitHub App to create or update workflow ' +
    '`.github/workflows/ci.yml` without `workflows` permission';

  it("appends the Workflows-permission fix to GitHub's refusal", () => {
    const explained = explainPushFailure(GITHUB_WORKFLOWS_REFUSAL);

    // The original GitHub message is kept, not replaced.
    expect(explained).toContain(GITHUB_WORKFLOWS_REFUSAL);
    expect(explained).toMatch(/Workflows: Read and write/i);
    expect(explained).toMatch(/Permissions & events/i);
  });

  it('leaves unrelated push failures untouched', () => {
    const message = "fatal: could not read Username for 'https://github.com'";

    expect(explainPushFailure(message)).toBe(message);
  });
});
