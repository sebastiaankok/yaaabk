import { OpenRouterApiError, toCostControlError, costControlError } from './errors';
import { OPENROUTER_BASE_URL } from './openrouter-http';
import type { CostControlResult } from './types';

/** How long the live OpenRouter catalogue is reused before refetching. */
export const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

/** The OpenCode provider prefix every catalogue entry carries. */
export const OPENROUTER_MODEL_PREFIX = 'openrouter/';

/**
 * One model the Plan page may offer for a Grill-Me Session.
 *
 * Prices are USD per million tokens, converted from OpenRouter's per-token
 * strings at the boundary so the UI never formats raw fractions.
 */
export interface SessionModel {
  /** OpenCode model id, e.g. `openrouter/anthropic/claude-sonnet-4.5`. */
  id: string;
  name: string;
  contextLength: number | null;
  promptUsdPerMillion: number | null;
  completionUsdPerMillion: number | null;
}

/** A live, filtered view of OpenRouter's model inventory. */
export interface ModelCatalogue {
  /** Tool-capable text models, cached briefly. */
  list(): Promise<CostControlResult<SessionModel[]>>;
}

export interface OpenRouterModelCatalogueOptions {
  /** Overrides {@link OPENROUTER_BASE_URL}, mainly for tests and proxies. */
  baseUrl?: string;
  /** Injected HTTP client. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Cache lifetime. Defaults to {@link MODEL_CACHE_TTL_MS}. */
  ttlMs?: number;
  /** Injected clock. Defaults to `() => new Date()`. */
  now?: () => Date;
}

interface RawModel {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown };
  architecture?: { modality?: unknown; output_modalities?: unknown };
  supported_parameters?: unknown;
}

/** Converts OpenRouter's per-token USD string to USD per million tokens. */
function perMillion(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 1_000_000 * 1e6) / 1e6;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function outputsText(model: RawModel): boolean {
  const outputs = model.architecture?.output_modalities;
  if (Array.isArray(outputs)) return outputs.includes('text');
  const modality = model.architecture?.modality;
  return typeof modality === 'string' && modality.endsWith('->text');
}

function supportsTools(model: RawModel): boolean {
  return Array.isArray(model.supported_parameters) && model.supported_parameters.includes('tools');
}

function toSessionModel(model: RawModel): SessionModel | undefined {
  if (typeof model.id !== 'string' || model.id.trim() === '') return undefined;
  const upstreamId = model.id.trim();
  return {
    id: upstreamId.startsWith(OPENROUTER_MODEL_PREFIX)
      ? upstreamId
      : `${OPENROUTER_MODEL_PREFIX}${upstreamId}`,
    name: typeof model.name === 'string' && model.name.trim() !== '' ? model.name : upstreamId,
    contextLength: numberOrNull(model.context_length),
    promptUsdPerMillion: perMillion(model.pricing?.prompt),
    completionUsdPerMillion: perMillion(model.pricing?.completion),
  };
}

/**
 * Reads OpenRouter's public model inventory, filtered to the models a session
 * can actually use: text output and tool calling.
 *
 * The catalogue changes frequently, so it is fetched live and cached briefly
 * rather than curated. Concurrent callers share one in-flight request, and a
 * failure is never cached.
 */
export function createOpenRouterModelCatalogue(
  options: OpenRouterModelCatalogueOptions = {},
): ModelCatalogue {
  const baseUrl = (options.baseUrl ?? OPENROUTER_BASE_URL).replace(/\/$/, '');
  const doFetch = options.fetch ?? globalThis.fetch;
  const ttlMs = options.ttlMs ?? MODEL_CACHE_TTL_MS;
  const now = options.now ?? (() => new Date());

  let cached: { models: SessionModel[]; fetchedAt: number } | undefined;
  let pending: Promise<CostControlResult<SessionModel[]>> | undefined;

  async function fetchCatalogue(): Promise<SessionModel[]> {
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}/models`, { method: 'GET' });
    } catch (error) {
      throw new OpenRouterApiError(error instanceof Error ? error.message : String(error), {
        network: true,
        cause: error,
      });
    }

    if (!response.ok) {
      const body = (await response.json().catch(() => undefined)) as
        { error?: { message?: string } } | undefined;
      throw new OpenRouterApiError(
        body?.error?.message ?? `OpenRouter responded with ${response.status}`,
        { statusCode: response.status },
      );
    }

    const body = (await response.json().catch(() => undefined)) as { data?: unknown } | undefined;
    if (!Array.isArray(body?.data)) {
      throw costControlError('server', 'OpenRouter returned an unexpected model catalogue');
    }

    return (body.data as RawModel[])
      .filter((model) => supportsTools(model) && outputsText(model))
      .map(toSessionModel)
      .filter((model): model is SessionModel => model !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  async function load(): Promise<CostControlResult<SessionModel[]>> {
    try {
      const models = await fetchCatalogue();
      cached = { models, fetchedAt: now().getTime() };
      return { ok: true, value: [...models] };
    } catch (error) {
      return { ok: false, error: toCostControlError('list', error) };
    }
  }

  return {
    list() {
      if (cached !== undefined && now().getTime() - cached.fetchedAt < ttlMs) {
        return Promise.resolve({ ok: true, value: [...cached.models] });
      }
      if (pending !== undefined) return pending;
      pending = load().finally(() => {
        pending = undefined;
      });
      return pending;
    },
  };
}
