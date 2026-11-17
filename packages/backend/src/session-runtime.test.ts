import { describe, expect, it } from 'vitest';
import { resolveSessionRuntimeMode } from './session-runtime';

describe('resolveSessionRuntimeMode', () => {
  it('uses the Kubernetes adapter inside a cluster', () => {
    expect(resolveSessionRuntimeMode({ KUBERNETES_SERVICE_HOST: '10.43.0.1' })).toBe('kubernetes');
  });

  it('uses the local adapter outside a cluster', () => {
    expect(resolveSessionRuntimeMode({})).toBe('local');
  });

  it('honours an explicit choice', () => {
    expect(
      resolveSessionRuntimeMode({
        YAAABK_SESSION_RUNTIME: 'local',
        KUBERNETES_SERVICE_HOST: '10.43.0.1',
      }),
    ).toBe('local');
    expect(resolveSessionRuntimeMode({ YAAABK_SESSION_RUNTIME: 'kubernetes' })).toBe('kubernetes');
  });

  it('rejects an unknown adapter name instead of silently picking one', () => {
    expect(() => resolveSessionRuntimeMode({ YAAABK_SESSION_RUNTIME: 'podman' })).toThrow(
      /YAAABK_SESSION_RUNTIME/,
    );
  });
});
