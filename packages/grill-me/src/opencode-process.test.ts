import { describe, expect, it, vi } from 'vitest';
import { createOpenCodeSpawner, type OpenCodeSpawnerOptions } from './opencode-process';
import type { OpenCodeProcess, OpenCodeSessionRequest } from './process';

const silent = { info: () => {}, error: () => {} };

function request(overrides: Partial<OpenCodeSessionRequest> = {}): OpenCodeSessionRequest {
  return {
    sessionId: 'session-1',
    projectId: 'proj-1',
    idea: 'An idea',
    skillLevel: 'expert',
    skillPath: '/skills/grill-me/SKILL.md',
    prompt: 'Refine this idea',
    onOutput: () => {},
    ...overrides,
  };
}

/** Spawns `command` with `args`, standing in for the OpenCode CLI. */
function spawner(options: OpenCodeSpawnerOptions) {
  return createOpenCodeSpawner({ logger: silent, ...options });
}

async function spawnAndTrack(
  options: OpenCodeSpawnerOptions,
  overrides: Partial<OpenCodeSessionRequest> = {},
): Promise<{ child: OpenCodeProcess }> {
  const child = await spawner(options).spawn(request(overrides));
  return { child };
}

describe('createOpenCodeSpawner', () => {
  it('streams stdout and writes messages to stdin', async () => {
    const output: string[] = [];
    const { child } = await spawnAndTrack(
      { command: 'sh', args: ['-c', 'cat'] },
      { onOutput: (chunk) => output.push(chunk) },
    );

    await child.send('hello');

    await vi.waitFor(() => expect(output.join('')).toBe('hello\n'));
    await child.stop();
    await expect(child.exited).resolves.toMatchObject({ signal: 'SIGTERM' });
  });

  it('forwards stderr and reports a non-zero exit code', async () => {
    const errors: string[] = [];
    const { child } = await spawnAndTrack(
      { command: 'sh', args: ['-c', 'echo boom >&2; exit 3'] },
      { onError: (chunk) => errors.push(chunk) },
    );

    await expect(child.exited).resolves.toMatchObject({ code: 3 });
    expect(errors.join('')).toContain('boom');
  });

  it('rejects when the command cannot be started', async () => {
    const spawn = spawner({ command: 'yaaabk-not-a-real-command' });

    await expect(spawn.spawn(request())).rejects.toThrow();
  });
});
