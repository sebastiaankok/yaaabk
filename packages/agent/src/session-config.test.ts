import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** The OpenCode config the image uses for Grill-Me Sessions. */
function sessionConfig(): {
  skills?: unknown;
  mcp?: { servers?: Record<string, { type?: string; command?: string[]; codemode?: boolean }> };
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
});
