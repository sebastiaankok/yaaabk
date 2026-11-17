import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** The OpenCode config the image uses for Grill-Me Sessions. */
function sessionConfig(): {
  skills?: unknown;
  mcp?: { servers?: Record<string, { type?: string; command?: string[]; codemode?: boolean }> };
  permission?: Record<string, unknown>;
} {
  const path = fileURLToPath(new URL('../opencode-session.json', import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as ReturnType<typeof sessionConfig>;
}

describe('the session OpenCode config', () => {
  it('registers the reporting MCP server on the model tool list', () => {
    const server = sessionConfig().mcp?.servers?.['yaaabk'];

    expect(server?.type).toBe('local');
    expect(server?.command?.join(' ')).toContain('grill-mcp');
    expect(server?.codemode).toBe(false);
  });

  it('loads the image-baked skills from the grill-skills directory', () => {
    expect(sessionConfig().skills).toContain('/app/grill-skills');
  });

  it('denies push, cluster mutations and secret-file reads while allowing routine inspection', () => {
    const permission = sessionConfig().permission as {
      bash: Record<string, string>;
      read: Record<string, string>;
      edit: Record<string, string>;
      external_directory: string;
    };

    expect(permission.bash['git push*']).toBe('deny');
    expect(permission.bash['kubectl apply*']).toBe('deny');
    expect(permission.bash['kubectl delete*']).toBe('deny');
    expect(permission.bash['kubectl patch*']).toBe('deny');
    expect(permission.bash['*']).toBe('allow');
    expect(permission.bash['kubectl get*']).toBeUndefined();
    expect(permission.bash['git status*']).toBeUndefined();

    expect(permission.read['**/.env']).toBe('deny');
    expect(permission.read['**/.env.*']).toBe('deny');
    expect(permission.read['**/*.pem']).toBe('deny');
    expect(permission.read['*']).toBe('allow');

    expect(permission.edit['*']).toBe('deny');
    expect(permission.edit['**']).toBe('allow');
    expect(permission.edit['**/.env']).toBe('deny');
    expect(permission.external_directory).toBe('deny');

    // OpenCode applies the last matching rule, so the broad allow must come
    // before the narrower denials.
    expect(Object.keys(permission.bash)[0]).toBe('*');
    expect(Object.keys(permission.read)[0]).toBe('*');
    expect(Object.keys(permission.edit)[0]).toBe('*');
  });
});
