import { describe, expect, it } from 'vitest';
import { providerFromSpec, CompositeProvider, type AscentRow, type AscentSeries } from '@eio/core';
import {
  chartDomain, chartSeries, fmtAxisT, fmtTPlus, labelY, layoutLabels, linePath, linear, niceTicks, phaseNow, postAscentLabel, readingAt, timeTicks,
  timelineEvents, valueDomain, visibleRows,
} from '../src/lib/ascent-chart';
import { mockAscentSeries, mockLaunches } from '../src/mock/generators';

const NOW = Date.parse('2026-10-22T12:00:00Z');
const launch = () => mockLaunches(NOW).launches.find((l) => l.name.includes('Group 15-15'))!;
const modeledSeries = (): AscentSeries => mockAscentSeries(launch())!;

const liveRows = (): AscentRow[] => [
  { tSec: 0, altKm: 0, speedKmS: 0, downrangeKm: 0 },
  { tSec: 60, altKm: 9, speedKmS: 0.4, downrangeKm: 10 },
  { tSec: 120, altKm: 38, speedKmS: 1.3, downrangeKm: 60 },
];
const withLive = (): AscentSeries => ({
  ...modeledSeries(), source: 'live',
  live: { rows: liveRows(), events: [{ name: 'MECO', label: 'MECO', tSec: 155, track: 'vehicle', reported: true }], updatedAt: 1, lastTSec: 120, extrapolatedFromSec: 120 },
});

describe('scales and ticks', () => {
  it('maps linearly and tolerates an empty domain', () => {
    const f = linear(0, 10, 100, 200);
    expect(f(0)).toBe(100);
    expect(f(5)).toBe(150);
    expect(linear(3, 3, 0, 10)(3)).toBe(0);
  });

  it('niceTicks picks 1/2/5 steps inside the range', () => {
    expect(niceTicks(0, 100, 4)).toEqual([0, 20, 40, 60, 80, 100]); // 25 is not a 1/2/5 step; 20 is the nearest
    expect(niceTicks(0, 7.6, 3)).toEqual([0, 2, 4, 6]);
    expect(niceTicks(0, 180, 3)).toEqual([0, 50, 100, 150]);
    expect(niceTicks(5, 5)).toEqual([5]);
  });

  it('timeTicks keeps at most ~6 labels and starts at 0', () => {
    expect(timeTicks(570)[0]).toBe(0);
    expect(timeTicks(570).length).toBeLessThanOrEqual(7);
    expect(timeTicks(1200).every((t) => t % 60 === 0)).toBe(true);
    expect(timeTicks(120)).toEqual([0, 60, 120]);
  });

  it('formats T+ for axes and readouts', () => {
    expect(fmtTPlus(150)).toBe('T+02:30');
    expect(fmtTPlus(-45)).toBe('T-00:45');
    expect(fmtTPlus(0)).toBe('T+00:00');
    expect(fmtAxisT(150)).toBe('2:30');
  });

  it('builds a compact path', () => {
    expect(linePath([[0, 1], [2.25, 3]])).toBe('M0.0 1.0L2.3 3.0');
    expect(linePath([])).toBe('');
  });
});

describe('series selection', () => {
  it('modeled-only series: three metrics, SECO + 60 s domain', () => {
    const s = modeledSeries();
    expect(chartSeries(s, 'altKm').map((c) => c.id)).toEqual(['modeled']);
    const seco = s.modeled!.events.find((e) => e.name === 'SECO')!.tSec;
    expect(chartDomain(s).tMax).toBe(seco + 60);
    const [lo, hi] = valueDomain(chartSeries(s, 'altKm'), chartDomain(s).tMax);
    expect(lo).toBe(0);
    expect(hi).toBeGreaterThanOrEqual(165);
    expect(hi).toBeLessThan(260);
  });

  it('adds the live series and keeps modeled for comparison', () => {
    const s = withLive();
    expect(chartSeries(s, 'speedKmS').map((c) => c.id)).toEqual(['modeled', 'live']);
    expect(chartSeries(s, 'speedKmS')[1].rows).toHaveLength(3);
  });

  it('file series have no speed', () => {
    const s: AscentSeries = { ...modeledSeries(), source: 'file', file: { id: 'f', rows: [{ tSec: 0, altKm: 0, downrangeKm: 0 }, { tSec: 700, altKm: 90, downrangeKm: 2000 }] } };
    expect(chartSeries(s, 'speedKmS').map((c) => c.id)).toEqual(['modeled']);
    expect(chartSeries(s, 'altKm').map((c) => c.id)).toEqual(['modeled', 'file']);
    expect(chartDomain(s).tMax).toBe(700);
  });

  it('visibleRows clips to the domain and thins long series while keeping the end', () => {
    const rows = Array.from({ length: 2000 }, (_, i) => ({ tSec: i, value: i }));
    const out = visibleRows(rows, 1000, 100);
    expect(out.length).toBeLessThanOrEqual(102);
    expect(out[out.length - 1].tSec).toBe(1000);
    expect(visibleRows([{ tSec: -5, value: 0 }, { tSec: 5, value: 1 }], 10)).toHaveLength(1);
  });

  it('reported events replace modeled ones of the same name', () => {
    const ev = timelineEvents(withLive());
    expect(ev.filter((e) => e.name === 'MECO')).toEqual([expect.objectContaining({ tSec: 155, reported: true })]);
    expect(ev.map((e) => e.tSec)).toEqual([...ev.map((e) => e.tSec)].sort((a, b) => a - b));
  });
});

describe('cursor readings', () => {
  it('follows the modeled curve with no live data', () => {
    const r = readingAt(modeledSeries(), 150)!;
    expect(r.source).toBe('modeled');
    expect(r.altKm).toBeGreaterThan(60);
    expect(r.speedKmS).toBeGreaterThan(2.2);
  });

  it('uses measured rows inside the live window, then the modeled shape re-anchored to the last point', () => {
    const s = withLive();
    expect(readingAt(s, 90)).toMatchObject({ source: 'live', altKm: 23.5 });
    const after = readingAt(s, 200)!;
    expect(after.source).toBe('extrapolated');
    const m = s.modeled!;
    const m120 = m.rows.find((r) => r.tSec === 120)!, m200 = m.rows.find((r) => r.tSec === 200)!;
    expect(after.altKm).toBeCloseTo(38 + (m200.altKm - m120.altKm), 6);
    expect(readingAt(s, 120)!.altKm).toBe(38);
  });

  it('is null without any data', () => {
    expect(readingAt({ ...modeledSeries(), modeled: null, source: null }, 10)).toBeNull();
  });

  it('names the current phase from the modeled spans', () => {
    const s = modeledSeries();
    expect(phaseNow(s, 100)!.id).toBe('first-stage');
    expect(phaseNow(s, 300)!.id).toBe('second-stage');
    expect(phaseNow(s, -1)).toBeUndefined();
  });

  it('tolerates the modeled orbit after the last phase: no phase span, labelled by what the flight went on to', () => {
    const s = modeledSeries();
    const end = s.modeled!.phases[s.modeled!.phases.length - 1].toSec;
    expect(end).toBe(1110);
    expect(phaseNow(s, 1000)!.label).toBe('ORBIT (HELD)');
    expect(phaseNow(s, end + 60)).toBeUndefined(); // the spans end with the held state; the orbit has no span
    expect(postAscentLabel(s, end + 60, true)).toBe('ON ORBIT (MODELED)');
    expect(postAscentLabel(s, end + 11.9 * 3600, true)).toBe('ON ORBIT (MODELED)');
    expect(postAscentLabel(s, end + 12.1 * 3600, true)).toBe('ASCENT COMPLETE'); // back at the pad marker
    expect(postAscentLabel(s, end + 60, false)).toBe('ASCENT COMPLETE'); // failed flight: no orbit
    // the chart range and the readings still stop at SECO + margin
    expect(chartDomain(s).tMax).toBe(570);
    expect(readingAt(s, end + 3600)).not.toBeNull();
  });
});

describe('label layout', () => {
  it('stacks colliding labels into rows and keeps spaced ones on row 0', () => {
    const placed = layoutLabels([
      { x: 100, text: 'MECO' }, { x: 102, text: 'SEP' }, { x: 106, text: 'SES' }, { x: 250, text: 'SECO' },
    ], 340);
    expect(placed.map((p) => p.row)).toEqual([0, 1, 2, 0]);
  });

  it('right-aligns labels that would overflow and caps the rows', () => {
    const [a] = layoutLabels([{ x: 335, text: 'LANDING' }], 340);
    expect(a.anchor).toBe('end');
    const many = layoutLabels(Array.from({ length: 8 }, (_, i) => ({ x: 100 + i, text: 'XXXX' })), 340, { maxRows: 3 });
    expect(Math.max(...many.map((p) => p.row))).toBeLessThanOrEqual(2);
  });

  it('puts the first label highest and later rows below it', () => {
    const ys = [0, 1, 2].map((row) => labelY(row, 3, 38, 10));
    expect(ys).toEqual([14, 24, 34]);
    expect(labelY(5, 3, 38, 10)).toBe(34); // rows past the cap land on the lowest row
    expect(labelY(0, 1, 38, 10)).toBe(34); // a single row sits next to the band
  });

  it('never lets a later label\'s leader line cross an earlier label\'s text', () => {
    const charW = 5.2, bandY = 38, bandH = 14, rowH = 10, rows = 3;
    const items = [
      { x: 100, text: 'MECO' }, { x: 102, text: 'SEP' }, { x: 106, text: 'SES' }, { x: 250, text: 'SECO' }, { x: 255, text: 'FAIRING' },
    ];
    const placed = layoutLabels(items, 340, { maxRows: rows });
    const box = (p: (typeof placed)[number]) => {
      const w = p.text.length * charW, y = labelY(p.row, rows, bandY, rowH);
      const x0 = p.anchor === 'start' ? p.x - 2 : p.x + 2 - w;
      return { x0, x1: x0 + w, y0: y - 8, y1: y };
    };
    for (let j = 1; j < placed.length; j++) {
      const leader = { x: placed[j].x, y0: labelY(placed[j].row, rows, bandY, rowH) + 2, y1: bandY + bandH };
      for (let i = 0; i < j; i++) {
        const b = box(placed[i]);
        const crosses = leader.x >= b.x0 && leader.x <= b.x1 && leader.y0 <= b.y1 && leader.y1 >= b.y0;
        expect(crosses, `${placed[j].text} leader through ${placed[i].text}`).toBe(false);
      }
    }
  });
});

describe('mock Starlink Group 15-15', () => {
  it('is a Vandenberg launch with a modeled composite ascent, events and phase labels', () => {
    const { launches, entities } = mockLaunches(NOW);
    const l = launch();
    expect(l.pad!.name).toBe('Space Launch Complex 4E');
    const e = entities.find((x) => x.id === l.entityId)!;
    expect(e.attrs).toMatchObject({ trajectorySource: 'modeled', ascentInclinationDeg: 70 });
    expect(e.events!.map((x) => x.name)).toContain('MECO');
    const p = providerFromSpec(e.provider!) as CompositeProvider;
    const net = Date.parse(l.net);
    expect(p.segmentAt(net + 240_000)!.phase).toBe('stage 2 burn');
    expect(p.stateAt(net + 240_000)).not.toBeNull();
    // non-Falcon launches stay at the pad and have no series
    const ariane = launches.find((x) => x.vehicle === 'Ariane 64')!;
    expect(mockAscentSeries(ariane)).toBeNull();
    expect(entities.find((x) => x.id === ariane.entityId)!.provider!.type).toBe('geodetic');
  });
});
