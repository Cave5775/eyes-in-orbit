import {
  ascentPhaseAt, sampleAscentRows, type AscentEvent, type AscentPhaseSpan, type AscentRow, type AscentSeries,
} from '@eio/core';

/** Pure helpers behind `ui/detail/AscentTelemetry.tsx`: scales, ticks, series selection, label layout. */

export type Metric = 'altKm' | 'speedKmS' | 'downrangeKm';
export type SeriesId = 'modeled' | 'live' | 'file';

export const METRICS: { key: Metric; title: string; unit: string }[] = [
  { key: 'altKm', title: 'ALTITUDE', unit: 'km' },
  { key: 'speedKmS', title: 'SPEED', unit: 'km/s' },
  { key: 'downrangeKm', title: 'DOWNRANGE', unit: 'km' },
];

export function linear(d0: number, d1: number, r0: number, r1: number): (v: number) => number {
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
  return (v) => r0 + (v - d0) * k;
}

/** Round, evenly spaced ticks (1/2/5 x 10^n) covering [min, max] with about `target` intervals. */
export function niceTicks(min: number, max: number, target = 4): number[] {
  if (!(max > min)) return [min];
  const raw = (max - min) / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].map((m) => m * mag).reduce((best, s) => (Math.abs(Math.log(s / raw)) < Math.abs(Math.log(best / raw)) ? s : best));
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Math.round(v / step) * step);
  return out;
}

/** T+ axis ticks every 1, 2 or 5 minutes depending on the span (at most ~6 ticks). */
export function timeTicks(tMax: number): number[] {
  const step = [60, 120, 300, 600].find((s) => tMax / s <= 6) ?? 900;
  const out: number[] = [];
  for (let t = 0; t <= tMax + 1e-9; t += step) out.push(t);
  return out;
}

const p2 = (n: number) => String(n).padStart(2, '0');

/** `T+02:30` / `T-00:45` (whole seconds). */
export function fmtTPlus(sec: number): string {
  const s = Math.round(Math.abs(sec));
  return `T${sec < 0 ? '-' : '+'}${p2(Math.floor(s / 60))}:${p2(s % 60)}`;
}

/** `2:30` axis label. */
export function fmtAxisT(sec: number): string {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${p2(s % 60)}`;
}

/** SVG path through the points, one decimal. */
export function linePath(pts: [number, number][]): string {
  return pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('');
}

export interface ChartSeries {
  id: SeriesId;
  label: string;
  rows: { tSec: number; value: number }[];
}

/** Series available for a metric: the plan (modeled or file) and the measured rows. File rows carry no speed. */
export function chartSeries(s: AscentSeries, metric: Metric): ChartSeries[] {
  const out: ChartSeries[] = [];
  if (s.modeled) out.push({ id: 'modeled', label: 'Modeled', rows: s.modeled.rows.map((r) => ({ tSec: r.tSec, value: r[metric] })) });
  if (s.file && metric !== 'speedKmS') out.push({ id: 'file', label: 'File', rows: s.file.rows.map((r) => ({ tSec: r.tSec, value: r[metric as 'altKm' | 'downrangeKm'] })) });
  if (s.live) out.push({ id: 'live', label: 'Live', rows: s.live.rows.map((r) => ({ tSec: r.tSec, value: r[metric] })) });
  return out;
}

/** Visible T+ range: nominal SECO plus a margin, or further when measured / file rows run longer. */
export function chartDomain(s: AscentSeries): { tMax: number } {
  const seco = s.modeled?.events.find((e) => e.name === 'SECO')?.tSec;
  const candidates = [
    seco !== undefined ? seco + 60 : 0,
    s.live ? s.live.lastTSec + 30 : 0,
    s.file ? s.file.rows[s.file.rows.length - 1].tSec : 0,
  ];
  return { tMax: Math.max(120, ...candidates) };
}

/** [0, top] of the value axis, with the maximum inside [0, tMax] rounded up to a tick. */
export function valueDomain(series: ChartSeries[], tMax: number): [number, number] {
  let max = 0;
  for (const s of series) for (const r of s.rows) if (r.tSec <= tMax && r.value > max) max = r.value;
  if (max <= 0) return [0, 1];
  const ticks = niceTicks(0, max * 1.04, 4);
  return [0, Math.max(ticks[ticks.length - 1], max)];
}

/** Rows within [0, tMax], thinned to at most `maxPoints` (always keeps the last in-range row). */
export function visibleRows(rows: { tSec: number; value: number }[], tMax: number, maxPoints = 400): { tSec: number; value: number }[] {
  const inRange = rows.filter((r) => r.tSec >= 0 && r.tSec <= tMax);
  if (inRange.length <= maxPoints) return inRange;
  const stride = Math.ceil(inRange.length / maxPoints);
  const out = inRange.filter((_, i) => i % stride === 0);
  if (out[out.length - 1] !== inRange[inRange.length - 1]) out.push(inRange[inRange.length - 1]);
  return out;
}

// ---------------------------------------------------------------- events + phases

/** Timeline events: modeled ones, with any reported by live telemetry replacing the same name. */
export function timelineEvents(s: AscentSeries): AscentEvent[] {
  const reported = s.live?.events ?? [];
  const names = new Set(reported.map((e) => e.name));
  return [...(s.modeled?.events ?? []).filter((e) => !names.has(e.name)), ...reported].sort((a, b) => a.tSec - b.tSec);
}

/** Phase spans of the modeled ascent (empty without a model). */
export function timelinePhases(s: AscentSeries): AscentPhaseSpan[] {
  return s.modeled?.phases ?? [];
}

export function phaseNow(s: AscentSeries, tSec: number): AscentPhaseSpan | undefined {
  return ascentPhaseAt(timelinePhases(s), tSec);
}

export interface PlacedLabel {
  x: number;
  text: string;
  row: number;
  anchor: 'start' | 'end';
}

/**
 * Greedy stacking of marker labels: each label goes in the first row where it does not touch the
 * previous label of that row. `x` are pixel positions in ascending order. Labels near the right
 * edge are right-aligned so they stay inside the plot.
 */
export function layoutLabels(items: { x: number; text: string }[], width: number, opts: { charW?: number; gap?: number; maxRows?: number } = {}): PlacedLabel[] {
  const charW = opts.charW ?? 5.2, gap = opts.gap ?? 4, maxRows = opts.maxRows ?? 4;
  const rowEnd: number[] = [];
  return items.map((it) => {
    const w = it.text.length * charW;
    const anchor: 'start' | 'end' = it.x + w > width ? 'end' : 'start';
    const x0 = anchor === 'start' ? it.x : it.x - w;
    let row = rowEnd.findIndex((end) => x0 >= end + gap);
    if (row < 0) row = rowEnd.length < maxRows ? rowEnd.length : rowEnd.indexOf(Math.min(...rowEnd));
    rowEnd[row] = x0 + w;
    return { x: it.x, text: it.text, row, anchor };
  });
}

// ---------------------------------------------------------------- cursor readout

export interface Reading {
  tSec: number;
  altKm?: number;
  speedKmS?: number;
  downrangeKm?: number;
  /** where the numbers come from */
  source: 'live' | 'extrapolated' | 'modeled' | 'file';
}

/**
 * Values at T+ `tSec`: measured while inside the live rows, the modeled curve offset to the last
 * measured point after them (`extrapolated`, same rule as the server), else the plan.
 */
export function readingAt(s: AscentSeries, tSec: number): Reading | null {
  const live = s.live?.rows;
  if (live && live.length) {
    const first = live[0], last = live[live.length - 1];
    if (tSec >= first.tSec && tSec <= last.tSec) {
      const r = sampleAscentRows<AscentRow>(live, tSec)!;
      return { tSec, altKm: r.altKm, speedKmS: r.speedKmS, downrangeKm: r.downrangeKm, source: 'live' };
    }
    if (tSec > last.tSec && s.modeled) {
      const m0 = sampleAscentRows(s.modeled.rows, last.tSec)!, m1 = sampleAscentRows(s.modeled.rows, tSec)!;
      return {
        tSec, altKm: Math.max(0, last.altKm + m1.altKm - m0.altKm), speedKmS: m1.speedKmS,
        downrangeKm: last.downrangeKm + m1.downrangeKm - m0.downrangeKm, source: 'extrapolated',
      };
    }
    if (tSec > last.tSec) return { tSec, altKm: last.altKm, speedKmS: last.speedKmS, downrangeKm: last.downrangeKm, source: 'extrapolated' };
  }
  if (s.source === 'file' && s.file) {
    const r = sampleAscentRows(s.file.rows, tSec)!;
    return { tSec, altKm: r.altKm, downrangeKm: r.downrangeKm, source: 'file' };
  }
  if (s.modeled) {
    const r = sampleAscentRows(s.modeled.rows, tSec)!;
    return { tSec, altKm: r.altKm, speedKmS: r.speedKmS, downrangeKm: r.downrangeKm, source: 'modeled' };
  }
  return null;
}

/** Whether `tSec` lies within the powered-ascent window worth following with a cursor. */
export function inFlightWindow(tSec: number, tMax: number): boolean {
  return tSec >= 0 && tSec <= tMax;
}
