import type { RunHistoryEntry } from '@yaaabk/stats';

/** Formats a `0..1` ratio as a whole percentage, or an em dash when unknown. */
export function formatPercent(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

/** Formats whole cents as dollars, e.g. `12345` becomes `$123.45`. */
export function formatDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Formats a duration in seconds as `45s`, `1m 30s` or `1h 1m`. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole}s`;
  if (whole < 3600) {
    const minutes = Math.floor(whole / 60);
    const remainder = whole % 60;
    return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
  }
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/** Builds the ISO range for the last `days` days, ending at `now`. */
export function rangeForDays(days: number, now: Date = new Date()): { from: string; to: string } {
  const from = new Date(now.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: now.toISOString() };
}

/** A point in an SVG viewport. */
export interface ChartPoint {
  x: number;
  y: number;
}

/** Scales a series into a `width` by `height` SVG viewport, zero at the bottom. */
export function chartPoints(
  values: readonly number[],
  width: number,
  height: number,
): ChartPoint[] {
  if (values.length === 0) return [];
  const max = Math.max(1, ...values);
  const step = values.length === 1 ? 0 : width / (values.length - 1);
  return values.map((value, index) => ({
    x: values.length === 1 ? width / 2 : index * step,
    y: height - (value / max) * height,
  }));
}

/** How the run history table is ordered. */
export type RunSort = 'newest' | 'cost' | 'duration';

/** Returns a new run history list ordered by the chosen column, newest first by default. */
export function sortRuns(runs: readonly RunHistoryEntry[], sort: RunSort): RunHistoryEntry[] {
  const byNewest = (a: RunHistoryEntry, b: RunHistoryEntry) =>
    b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
  return [...runs].sort((a, b) => {
    if (sort === 'cost') return b.costCents - a.costCents || byNewest(a, b);
    if (sort === 'duration')
      return (b.durationSeconds ?? -1) - (a.durationSeconds ?? -1) || byNewest(a, b);
    return byNewest(a, b);
  });
}

/** A bar in the run-duration chart. */
export interface AttemptDuration {
  attemptNumber: number;
  averageSeconds: number;
  runs: number;
}

/** Averages completed run durations per attempt number, ascending. */
export function durationByAttempt(runs: readonly RunHistoryEntry[]): AttemptDuration[] {
  const byAttempt = new Map<number, { total: number; runs: number }>();
  for (const run of runs) {
    if (run.durationSeconds === null) continue;
    const entry = byAttempt.get(run.attemptNumber) ?? { total: 0, runs: 0 };
    entry.total += run.durationSeconds;
    entry.runs += 1;
    byAttempt.set(run.attemptNumber, entry);
  }
  return [...byAttempt.entries()]
    .map(([attemptNumber, entry]) => ({
      attemptNumber,
      averageSeconds: entry.total / entry.runs,
      runs: entry.runs,
    }))
    .sort((a, b) => a.attemptNumber - b.attemptNumber);
}

/** One slice of the status donut. */
export interface DonutSegment {
  value: number;
  color: string;
}

/** Turns segment values into a `conic-gradient` for the status donut. */
export function donutGradient(segments: readonly DonutSegment[]): string {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  if (total === 0) return 'conic-gradient(#e5e5e5 0% 100%)';
  let cursor = 0;
  const stops = segments
    .filter((segment) => segment.value > 0)
    .map((segment) => {
      const start = (cursor / total) * 100;
      cursor += segment.value;
      const end = (cursor / total) * 100;
      return `${segment.color} ${start}% ${end}%`;
    });
  return `conic-gradient(${stops.join(', ')})`;
}
