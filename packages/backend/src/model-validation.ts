import type { ModelCatalogue } from '@yaaabk/cost-control';
import type { Context } from 'hono';

/** A model field read from a request body: a model id, an explicit clear, or invalid. */
export type ParsedAgentModel = { ok: true; value: string | null } | { ok: false };

/**
 * Reads `agentModel`/`agent_model`, telling an omitted field apart from an
 * explicit `null` (which clears the setting). An empty string is treated as a
 * clear, matching what an emptied UI input sends.
 */
export function parseAgentModel(input: Record<string, unknown>): ParsedAgentModel | undefined {
  const value = input.agentModel !== undefined ? input.agentModel : input.agent_model;
  if (value === undefined) return undefined;
  if (value === null) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false };
  const trimmed = value.trim();
  return { ok: true, value: trimmed === '' ? null : trimmed };
}

/**
 * Validates a non-null model against the live, tool-capable OpenRouter
 * catalogue, mirroring the Grill-Me start route. Returns the response to send
 * when the model is unusable, or `null` when it is accepted.
 */
export async function validateAgentModel(
  c: Context,
  catalogue: ModelCatalogue | undefined,
  model: string,
): Promise<Response | null> {
  if (catalogue === undefined) return null;
  const result = await catalogue.list();
  if (!result.ok) {
    return c.json(
      {
        error: result.error.kind,
        message: `Could not load the model catalogue: ${result.error.message}`,
      },
      502,
    );
  }
  if (!result.value.some((entry) => entry.id === model)) {
    return c.json(
      {
        error: 'invalid-model',
        message: `"${model}" is not a tool-capable model in the OpenRouter catalogue`,
      },
      400,
    );
  }
  return null;
}

/** Writes the 400 response for a model field that is neither text nor null. */
export function invalidModelField(c: Context) {
  return c.json({ error: 'invalid-input', message: 'The agent model must be text or null' }, 400);
}
