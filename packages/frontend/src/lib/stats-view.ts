import type { RunHistoryEntry } from '@yaaabk/stats';
import { compactTokens } from './agent-run.js';

/** Formats a `0..1` ratio as a whole percentage, or an em dash when unknown. */
export function formatPercent(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

/** Formats whole cents as dollars, e.g. `12345` becomes `$123.45`. */
export function formatDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Formats measured tokens compactly, prefixing `≥` when some model runs could
 * not be measured. Unknown usage is an em dash, never zero.
 */
export function formatCoveredTokens(
  tokens: number | null,
  measuredRuns: number,
  modelRuns: number,
): string {
  if (tokens === null) return '—';
  return `${measuredRuns < modelRuns ? '≥ ' : ''}${compactTokens(tokens)}`;
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

/** Room around the plot area for axis labels. */
export interface ChartPadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** The value range an area chart covers. */
export interface ChartBounds {
  min: number;
  max: number;
}

/** One labelled position on an axis. */
export interface ChartTick {
  /** Position along the axis in viewport units. */
  offset: number;
  /** The data value on the y axis, or the point index on the x axis. */
  value: number;
  label: string;
}

/** The plot area, excluding the padding reserved for labels. */
export interface ChartPlot {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Everything needed to draw one area chart, without touching a value formatter. */
export interface ChartGeometry {
  width: number;
  height: number;
  plot: ChartPlot;
  bounds: ChartBounds;
  points: ChartPoint[];
  linePath: string;
  areaPath: string;
  yTicks: ChartTick[];
  xTicks: ChartTick[];
}

/** How to lay out an area chart. Every field has a default. */
export interface ChartGeometryOptions {
  width?: number;
  height?: number;
  padding?: Partial<ChartPadding>;
  /** Intervals the value axis is divided into before tick values are chosen. */
  tickIntervals?: number;
  /** Most x-axis labels to show; the first and last are always included. */
  xTickCount?: number;
}

const DEFAULT_PADDING: ChartPadding = { top: 12, right: 12, bottom: 24, left: 44 };

/** Round `raw` up to a step that reads well as a tick: 1, 2, 2.5, 5 or 10 times a power of ten. */
function niceStep(raw: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / magnitude;
  const nice =
    fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * magnitude;
}

/** Formats a tick without trailing zeros while keeping fractional steps readable. */
function formatTick(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

/**
 * Lays a series out as an area chart: a bounds-aware value axis, evenly spaced
 * x ticks, and line and area paths. A single point sits in the middle of the
 * plot; an empty series keeps the axis so the chart can still draw a baseline.
 */
export function chartGeometry(
  values: readonly number[],
  options: ChartGeometryOptions = {},
): ChartGeometry {
  const width = options.width ?? 600;
  const height = options.height ?? 200;
  const padding = { ...DEFAULT_PADDING, ...options.padding };
  const tickIntervals = options.tickIntervals ?? 4;
  const plot: ChartPlot = {
    x: padding.left,
    y: padding.top,
    width: width - padding.left - padding.right,
    height: height - padding.top - padding.bottom,
  };

  const maxValue = values.length === 0 ? 0 : Math.max(0, ...values);
  const step = Math.max(1, niceStep(Math.max(1, maxValue) / tickIntervals));
  const max = Math.max(step, Math.ceil(maxValue / step) * step);
  const yTicks: ChartTick[] = [];
  const tickCount = Math.round(max / step);
  for (let index = 0; index <= tickCount; index += 1) {
    const value = index * step;
    yTicks.push({
      value,
      offset: plot.y + plot.height - (value / max) * plot.height,
      label: formatTick(value),
    });
  }

  const baseline = plot.y + plot.height;
  const points: ChartPoint[] = values.map((value, index) => ({
    x:
      values.length === 1
        ? plot.x + plot.width / 2
        : plot.x + (index / (values.length - 1)) * plot.width,
    y: plot.y + plot.height - (value / max) * plot.height,
  }));

  const linePath =
    points.length === 0
      ? ''
      : `M ${points[0].x} ${points[0].y}${points
          .slice(1)
          .map((point) => ` L ${point.x} ${point.y}`)
          .join('')}`;
  const areaPath =
    points.length === 0
      ? ''
      : `${linePath} L ${points[points.length - 1].x} ${baseline} L ${points[0].x} ${baseline} Z`;

  const xTickCount = Math.min(values.length, options.xTickCount ?? 5);
  const indexes = new Set<number>();
  for (let index = 0; index < xTickCount; index += 1) {
    indexes.add(
      xTickCount === 1 ? 0 : Math.round((index / (xTickCount - 1)) * (values.length - 1)),
    );
  }
  const xTicks: ChartTick[] = [...indexes]
    .sort((a, b) => a - b)
    .map((index) => ({ offset: points[index].x, value: index, label: String(index) }));

  return {
    width,
    height,
    plot,
    bounds: { min: 0, max },
    points,
    linePath,
    areaPath,
    yTicks,
    xTicks,
  };
}

/** The point nearest to `x`, or `null` for an empty series. Ties pick the lower index. */
export function nearestChartIndex(points: readonly ChartPoint[], x: number): number | null {
  if (points.length === 0) return null;
  let nearest = 0;
  for (let index = 1; index < points.length; index += 1) {
    if (Math.abs(points[index].x - x) < Math.abs(points[nearest].x - x)) nearest = index;
  }
  return nearest;
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
