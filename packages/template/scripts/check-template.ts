#!/usr/bin/env bun
/**
 * Runs the scaffolded project's own checks, as an Agent would.
 *
 * The Agent runtime judges every attempt with the template's `check` script, so
 * the template must pass that script in the image the Agent runs in. This is
 * the gate `packages/agent/Dockerfile` runs at image build time: a template that
 * needs a binary the image lacks (Node, for Vitest) fails the build instead of
 * every Agent run.
 *
 * Run it from a checkout with `bun run --filter '@yaaabk/template' check:template`.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGitBackend } from '../src/fake-git-backend';
import { createTemplateModule } from '../src/template';

/** The in-repo template this script exercises. */
const TEMPLATE_DIR = join(import.meta.dir, '..', '..', '..', 'templates', 'svelte-bun');

/** A scaffold needs a valid project name, id and repository URL, nothing more. */
const PROJECT = {
  id: 'a1b2c3d4-1111-4111-8111-111111111111',
  name: 'todo-app',
  repoUrl: 'https://github.com/yaaabk/todo-app.git',
};

/** Runs a command in `cwd`, streaming its output, and throws on failure. */
function run(command: string[], cwd: string): void {
  const result = Bun.spawnSync(command, {
    cwd,
    // An Agent Job is not interactive either: keep every tool in its one-shot
    // mode so a watcher cannot hold the build open.
    env: { ...process.env, CI: '1' },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(' ')} exited with code ${result.exitCode}`);
  }
}

const workDir = await mkdtemp(join(tmpdir(), 'yaaabk-template-check-'));
try {
  const scaffold = await createTemplateModule({
    git: createFakeGitBackend(),
    workDir,
    source: { type: 'directory', path: TEMPLATE_DIR },
  }).scaffold(PROJECT);

  if (!scaffold.ok) {
    throw new Error(`scaffolding failed: ${scaffold.error.message}`);
  }

  const directory = scaffold.value.directory;
  console.log(`template-check: scaffolded ${PROJECT.name} in ${directory}`);

  // The Agent installs dependencies before running OpenCode, and again when the
  // checks run. Do the same so the gate covers the exact path.
  run(['bun', 'install', '--frozen-lockfile'], directory);
  run(['bun', 'run', 'check'], directory);

  console.log('template-check: the scaffolded project passed bun run check');
} finally {
  await rm(workDir, { recursive: true, force: true });
}
