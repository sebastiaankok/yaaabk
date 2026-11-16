/**
 * The OpenCode runtime settings Agent Jobs and Grill-Me Sessions share.
 *
 * Both runtimes execute the same pinned CLI against the same provider, so the
 * model default and its environment override live here rather than being
 * configured twice.
 */

/** Default OpenCode model when configuration does not choose one. */
export const DEFAULT_OPENCODE_MODEL = 'openrouter/anthropic/claude-sonnet-4.5';

/**
 * Resolves the model OpenCode should run.
 *
 * An explicit choice (a Session's model picker) wins; when it is absent or
 * blank the deployment default applies, which is itself the shared default.
 * Environment lookups stay with the callers so this module remains runtime
 * agnostic.
 */
export function resolveOpenCodeModel(
  requested?: string,
  fallback: string = DEFAULT_OPENCODE_MODEL,
): string {
  const trimmed = requested?.trim();
  return trimmed !== undefined && trimmed !== '' ? trimmed : fallback;
}
