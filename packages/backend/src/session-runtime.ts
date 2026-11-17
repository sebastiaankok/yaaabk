/** Chooses the SessionRuntime adapter a deployment runs. */
export type SessionRuntimeMode = 'local' | 'kubernetes';

/**
 * Resolves the adapter from `YAAABK_SESSION_RUNTIME`, falling back to the
 * environment: a Pod has `KUBERNETES_SERVICE_HOST`, a laptop does not.
 */
export function resolveSessionRuntimeMode(
  env: Record<string, string | undefined>,
): SessionRuntimeMode {
  const configured = env['YAAABK_SESSION_RUNTIME']?.trim().toLowerCase();
  if (configured === 'local' || configured === 'kubernetes') return configured;
  if (configured !== undefined && configured !== '') {
    throw new Error(
      `YAAABK_SESSION_RUNTIME must be "local" or "kubernetes", received: ${configured}`,
    );
  }
  return env['KUBERNETES_SERVICE_HOST'] === undefined ? 'local' : 'kubernetes';
}
