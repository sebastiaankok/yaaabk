import type { Project, ProjectsModule } from '@yaaabk/projects';
import type { SkillLevel } from '@yaaabk/shared';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** Reads a request body as a plain object, tolerating empty or malformed JSON. */
export async function body(c: Context): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await c.req.json();
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Reads a string field, treating anything else as absent. */
export function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Reads the skill level from either the camelCase or the documented snake_case key. */
export function asSkillLevel(input: Record<string, unknown>): SkillLevel {
  return (input.skillLevel ?? input.skill_level) as SkillLevel;
}

/** Reads a plan source, defaulting to `grill-me`. */
export function asSource(input: Record<string, unknown>): 'grill-me' | 'upload' {
  return input.source === 'upload' ? 'upload' : 'grill-me';
}

/** Writes a typed error in the API's standard `{ error, message }` shape. */
export function fail(
  c: Context,
  error: { kind: string; message: string },
  status: ContentfulStatusCode,
) {
  return c.json({ error: error.kind, message: error.message }, status);
}

/**
 * Resolves a Project or writes the matching 404/500 response.
 *
 * Returns the Project on success; a `Response` when the caller must return it.
 */
export async function projectOrResponse(
  c: Context,
  projects: ProjectsModule,
  id: string,
): Promise<Project | Response> {
  const result = await projects.get(id);
  if (result.ok) {
    return result.value;
  }
  if (result.error.kind === 'not-found') {
    return fail(c, result.error, 404);
  }
  return fail(c, result.error, 500);
}
