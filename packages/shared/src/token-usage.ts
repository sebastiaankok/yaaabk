/**
 * Token usage of one model invocation.
 *
 * OpenCode reports these five components for a session; they are kept separate
 * so the UI can show the input, output and cached portions without losing what
 * the provider actually charged for.
 */
export interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cache: {
    read: number;
    write: number;
  };
}

/** Whether `value` is a non-negative integer. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Narrows an unknown value to a complete {@link TokenUsage}.
 *
 * All-or-nothing: a partial object is rejected rather than filled with zeroes,
 * so an unmeasured run is never confused with one that used no tokens.
 */
export function isTokenUsage(value: unknown): value is TokenUsage {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const cache = candidate['cache'];
  if (typeof cache !== 'object' || cache === null) return false;
  const cacheCounts = cache as Record<string, unknown>;
  return (
    isCount(candidate['input']) &&
    isCount(candidate['output']) &&
    isCount(candidate['reasoning']) &&
    isCount(cacheCounts['read']) &&
    isCount(cacheCounts['write'])
  );
}

/** Every token the invocation consumed, cache reads and writes included. */
export function tokenUsageTotal(usage: TokenUsage): number {
  return usage.input + usage.output + usage.reasoning + usage.cache.read + usage.cache.write;
}

/** Adds two usages component-wise, for summing a run's retries. */
export function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cache: {
      read: a.cache.read + b.cache.read,
      write: a.cache.write + b.cache.write,
    },
  };
}
