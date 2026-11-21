import { describe, expect, it } from 'vitest';
import type { RunHistoryEntry } from '@yaaabk/stats';
import {
  chartGeometry,
  donutGradient,
  durationByAttempt,
  formatCoveredTokens,
  formatDollars,
  formatDuration,
  formatPercent,
  nearestChartIndex,
  rangeForDays,
  sortRuns,
} from './stats-view';

describe('formatPercent', () => {
  it('renders a ratio as a whole percentage', () => {
    expect(formatPercent(2 / 3)).toBe('67%');
  });

  it('renders a placeholder before there is data', () => {
    expect(formatPercent(null)).toBe('—');
  });
});

describe('formatDollars', () => {
  it('renders whole cents as dollars with two decimals', () => {
    expect(formatDollars(5)).toBe('$0.05');
    expect(formatDollars(12345)).toBe('$123.45');
  });
});

describe('formatCoveredTokens', () => {
  it('compacts a fully measured total', () => {
    expect(formatCoveredTokens(41_700, 4, 4)).toBe('41.7k');
  });

  it('marks a total that misses an unmeasured model run', () => {
    expect(formatCoveredTokens(41_700, 3, 4)).toBe('≥ 41.7k');
  });

  it('renders an unknown total as a dash', () => {
    expect(formatCoveredTokens(null, 0, 2)).toBe('—');
  });
});

describe('formatDuration', () => {
  it('renders seconds, minutes and hours compactly', () => {
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(90)).toBe('1m 30s');
    expect(formatDuration(3600)).toBe('1h');
    expect(formatDuration(3660)).toBe('1h 1m');
  });

  it('renders a placeholder for an unfinished run', () => {
    expect(formatDuration(null)).toBe('—');
  });
});

describe('rangeForDays', () => {
  it('returns an inclusive ISO range ending at now', () => {
    const now = new Date('2026-02-01T12:00:00.000Z');

    expect(rangeForDays(7, now)).toEqual({
      from: '2026-01-26T12:00:00.000Z',
      to: '2026-02-01T12:00:00.000Z',
    });
  });
});

describe('chartGeometry', () => {
  it('keeps an empty series empty while still drawing an axis from zero to one', () => {
    const chart = chartGeometry([]);

    expect(chart.points).toEqual([]);
    expect(chart.linePath).toBe('');
    expect(chart.areaPath).toBe('');
    expect(chart.xTicks).toEqual([]);
    expect(chart.bounds).toEqual({ min: 0, max: 1 });
    expect(chart.yTicks.map((tick) => tick.value)).toEqual([0, 1]);
    expect(chart.yTicks[0].offset).toBe(chart.plot.y + chart.plot.height);
    expect(chart.yTicks.at(-1)?.offset).toBe(chart.plot.y);
  });

  it('centres a single point in the plot and fills down to the baseline', () => {
    const chart = chartGeometry([2], { width: 100, height: 100 });

    expect(chart.plot).toEqual({ x: 44, y: 12, width: 44, height: 64 });
    expect(chart.points).toEqual([{ x: 66, y: 12 }]);
    expect(chart.linePath).toBe('M 66 12');
    expect(chart.areaPath).toBe('M 66 12 L 66 76 L 66 76 Z');
    expect(chart.xTicks).toEqual([{ offset: 66, value: 0, label: '0' }]);
  });

  it('places a multi-point series across the plot with a readable value axis', () => {
    const chart = chartGeometry([0, 2, 1]);

    expect(chart.plot).toEqual({ x: 44, y: 12, width: 544, height: 164 });
    expect(chart.bounds).toEqual({ min: 0, max: 2 });
    expect(chart.points).toEqual([
      { x: 44, y: 176 },
      { x: 316, y: 12 },
      { x: 588, y: 94 },
    ]);
    expect(chart.yTicks).toEqual([
      { value: 0, offset: 176, label: '0' },
      { value: 1, offset: 94, label: '1' },
      { value: 2, offset: 12, label: '2' },
    ]);
    expect(chart.xTicks).toEqual([
      { offset: 44, value: 0, label: '0' },
      { offset: 316, value: 1, label: '1' },
      { offset: 588, value: 2, label: '2' },
    ]);
    expect(chart.linePath).toBe('M 44 176 L 316 12 L 588 94');
    expect(chart.areaPath).toBe('M 44 176 L 316 12 L 588 94 L 588 176 L 44 176 Z');
  });

  it('rounds the value axis up to a step that reads well', () => {
    const chart = chartGeometry([0, 7, 2], { xTickCount: 2 });

    expect(chart.bounds).toEqual({ min: 0, max: 8 });
    expect(chart.yTicks.map((tick) => tick.label)).toEqual(['0', '2', '4', '6', '8']);
    expect(chart.xTicks.map((tick) => tick.value)).toEqual([0, 2]);
  });
});

describe('nearestChartIndex', () => {
  const points = [
    { x: 0, y: 10 },
    { x: 50, y: 20 },
    { x: 100, y: 30 },
  ];

  it('finds the point nearest to the pointer, including the ends', () => {
    expect(nearestChartIndex(points, -20)).toBe(0);
    expect(nearestChartIndex(points, 24)).toBe(0);
    expect(nearestChartIndex(points, 26)).toBe(1);
    expect(nearestChartIndex(points, 80)).toBe(2);
    expect(nearestChartIndex(points, 400)).toBe(2);
  });

  it('has no answer for an empty series', () => {
    expect(nearestChartIndex([], 10)).toBeNull();
  });
});

function historyRun(overrides: Partial<RunHistoryEntry> & { id: string }): RunHistoryEntry {
  return {
    issueId: 'schema',
    issueTitle: 'Schema',
    attemptNumber: 1,
    status: 'success',
    durationSeconds: null,
    costCents: 0,
    tokens: null,
    prUrl: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('sortRuns', () => {
  const runs = [
    historyRun({ id: 'old-cheap', createdAt: '2026-01-01T00:00:00.000Z', costCents: 1 }),
    historyRun({ id: 'new-pricey', createdAt: '2026-01-03T00:00:00.000Z', costCents: 20 }),
    historyRun({
      id: 'middle-long',
      createdAt: '2026-01-02T00:00:00.000Z',
      durationSeconds: 300,
    }),
  ];

  it('sorts by cost, duration or newest without mutating the input', () => {
    expect(sortRuns(runs, 'cost').map((run) => run.id)).toEqual([
      'new-pricey',
      'old-cheap',
      'middle-long',
    ]);
    expect(sortRuns(runs, 'duration').map((run) => run.id)).toEqual([
      'middle-long',
      'new-pricey',
      'old-cheap',
    ]);
    expect(sortRuns(runs, 'newest').map((run) => run.id)).toEqual([
      'new-pricey',
      'middle-long',
      'old-cheap',
    ]);
    expect(runs.map((run) => run.id)).toEqual(['old-cheap', 'new-pricey', 'middle-long']);
  });
});

describe('durationByAttempt', () => {
  it('averages completed run durations per attempt number', () => {
    const runs = [
      historyRun({ id: 'a1', attemptNumber: 1, durationSeconds: 100 }),
      historyRun({ id: 'a2', attemptNumber: 1, durationSeconds: 200 }),
      historyRun({ id: 'a3', attemptNumber: 2, durationSeconds: 50 }),
      historyRun({ id: 'a4', attemptNumber: 3, durationSeconds: null }),
    ];

    expect(durationByAttempt(runs)).toEqual([
      { attemptNumber: 1, averageSeconds: 150, runs: 2 },
      { attemptNumber: 2, averageSeconds: 50, runs: 1 },
    ]);
  });
});

describe('donutGradient', () => {
  it('turns segment values into a conic gradient', () => {
    expect(
      donutGradient([
        { value: 1, color: '#111111' },
        { value: 3, color: '#888888' },
      ]),
    ).toBe('conic-gradient(#111111 0% 25%, #888888 25% 100%)');
  });

  it('renders an empty ring when every segment is zero', () => {
    expect(donutGradient([{ value: 0, color: '#111111' }])).toBe('conic-gradient(#e5e5e5 0% 100%)');
  });
});
