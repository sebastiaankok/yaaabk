import type { AgentRunKind } from '@yaaabk/agents';
import { tokenUsageTotal, type TokenUsage } from '@yaaabk/shared';

/** Just enough of an Agent run to name it in the UI. */
export interface LabelledRun {
  kind: AgentRunKind;
  attemptNumber: number;
}

/**
 * How a run is named for a Developer, so a review or a conflict fix is not
 * mistaken for an implementation attempt.
 */
export function runLabel(run: LabelledRun): string {
  if (run.kind === 'review') return `Review ${run.attemptNumber}`;
  if (run.kind === 'resolve-conflicts') return `Conflict fix ${run.attemptNumber}`;
  if (run.kind === 'deploy') return `Deploy ${run.attemptNumber}`;
  return `Attempt ${run.attemptNumber}`;
}

/** The input, generated and cached portions of an Issue's token usage. */
export interface TokenBreakdown {
  input: number;
  output: number;
  cached: number;
}

/** An Issue's token usage across its model runs. */
export interface IssueTokenSummary {
  /** The measured total, or `null` when no model run could be measured. */
  total: number | null;
  /** Whether at least one model run is unmeasured. */
  partial: boolean;
  /** The measured components, or `null` with {@link total}. */
  breakdown: TokenBreakdown | null;
}

/** Tokens one run used, or `null` when its usage was never measured. */
export function runTokenTotal(tokens: TokenUsage | null | undefined): number | null {
  return tokens == null ? null : tokenUsageTotal(tokens);
}

/**
 * Sums an Issue's measured model runs.
 *
 * Deploy runs never invoke a model, so they are ignored rather than counted as
 * unmeasured. A model run without usage makes the total partial: the measured
 * runs still add up, but the real total is at least that much.
 */
export function issueTokenSummary(
  runs: ReadonlyArray<{ kind: AgentRunKind; tokens: TokenUsage | null | undefined }>,
): IssueTokenSummary {
  let input = 0;
  let output = 0;
  let cached = 0;
  let measured = 0;
  let unmeasured = 0;

  for (const run of runs) {
    if (run.kind === 'deploy') continue;
    if (run.tokens == null) {
      unmeasured += 1;
      continue;
    }
    measured += 1;
    input += run.tokens.input;
    // Reasoning is generated output too, so the UI's "out" covers both.
    output += run.tokens.output + run.tokens.reasoning;
    cached += run.tokens.cache.read + run.tokens.cache.write;
  }

  if (measured === 0) {
    return { total: null, partial: unmeasured > 0, breakdown: null };
  }
  return {
    total: input + output + cached,
    partial: unmeasured > 0,
    breakdown: { input, output, cached },
  };
}

const NUMBER = new Intl.NumberFormat('en-US');

/** A full token count with thousands separators, or `—` when unknown. */
export function formatTokens(value: number | null): string {
  return value === null ? '—' : NUMBER.format(value);
}

/** Rounds `value` to one decimal of `divisor`, dropping a trailing `.0`. */
function scaled(value: number, divisor: number): string {
  return (Math.round(value / (divisor / 10)) / 10).toFixed(1).replace(/\.0$/, '');
}

/**
 * A compact token count for a run row: `999`, `1.2k`, `19.7k`, `1.5M`.
 *
 * Unknown usage renders as an em dash, never as zero.
 */
export function compactTokens(value: number | null): string {
  if (value === null) return '—';
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${scaled(value, 1_000)}k`;
  return `${scaled(value, 1_000_000)}M`;
}
