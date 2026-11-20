import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeGitBackend } from './fake-git-backend';
import { createTemplateModule } from './template';
import type { TemplateProject } from './types';

/**
 * The scaffolded project is the Agent's whole world; it must explain its own
 * commands and constraints instead of making the Agent explore the repository.
 */

const PROJECT: TemplateProject = {
  id: 'a1b2c3d4-1111-4111-8111-111111111111',
  name: 'todo-app',
  repoUrl: 'git@github.com:acme/todo-app.git',
};

const silent = { info: () => {}, error: () => {} };

describe('the scaffolded project is agent-friendly', () => {
  let directory: string;
  let files: string[];

  beforeAll(async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'yaaabk-agent-friendly-'));
    const module = createTemplateModule({
      git: createFakeGitBackend(),
      workDir,
      logger: silent,
    });

    const result = await module.scaffold(PROJECT);
    if (!result.ok) throw new Error(`scaffolding failed: ${result.error.message}`);
    directory = result.value.directory;
    files = result.value.files;
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function read(relative: string): Promise<string> {
    return readFile(join(directory, relative), 'utf8');
  }

  it('ships an AGENTS.md with the repo map, exact commands and the no-browser rule', async () => {
    expect(files).toContain('AGENTS.md');

    const agents = await read('AGENTS.md');

    expect(agents).toContain('web/');
    expect(agents).toContain('server/');
    expect(agents).toContain('scripts/smoke.ts');
    expect(agents).toContain('bun run check');
    expect(agents).toContain('bun run smoke');
    expect(agents).toContain('bun run build');
    expect(agents).toMatch(/no browser/i);
  });

  it('defines check as lint, typecheck, tests and build, and exposes smoke', async () => {
    const pkg = JSON.parse(await read('package.json')) as {
      scripts: Record<string, string>;
    };
    const check = pkg.scripts['check'] ?? '';

    expect(check).toContain('bun run lint');
    expect(check).toContain('bun run typecheck');
    expect(check).toContain('bun run test');
    expect(check).toContain('bun run build');
    expect(pkg.scripts['smoke']).toBe('bun scripts/smoke.ts');
    expect(files).toContain('scripts/smoke.ts');
  });

  it('ignores local Agent state and ships no dead pre-commit configuration', async () => {
    const gitignore = await read('.gitignore');

    expect(gitignore.split('\n')).toContain('.yaaabk/');
    expect(files).not.toContain('.pre-commit-config.yaml');
  });

  it('points the README at the same commands as AGENTS.md', async () => {
    const [readme, agents] = await Promise.all([read('README.md'), read('AGENTS.md')]);

    for (const command of ['bun run check', 'bun run smoke', 'bun run build']) {
      expect(agents, `AGENTS.md is missing ${command}`).toContain(command);
      expect(readme, `README.md is missing ${command}`).toContain(command);
    }
  });

  it('says accepted Plans live in docs/plans and the Issue-named version is binding', async () => {
    const agents = await read('AGENTS.md').catch(() => '');

    expect(agents).toContain('docs/plans/');
    expect(agents).toMatch(/accepted Plans/i);
    expect(agents).toContain('binding');
  });
});
