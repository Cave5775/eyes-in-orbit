import { readFileSync } from 'node:fs';
import { CompositeProvider, DEG, providerFromSpec, stateToGeodetic, type AscentSeries } from '@eio/core';
import { describe, expect, it } from 'vitest';
import { normalizeLaunch, syncLaunchEntities } from '../../../src/engine/connectors/launchlibrary';
import { Hub } from '../../../src/engine/hub';
import { buildSeries, mergeLive, validateTelemetryBody } from '../../../src/engine/telemetry';
import { matchTrajectory, parseTrajectory } from '../../../src/engine/trajectory';

// ported from the server's telemetry test: the validation and merge rules and what a live ascent does to the launch entity.
// The server's POST/GET/DELETE route tests, the local-request check and the persistence belong to the transport and arrive with it.
const raw = () => JSON.parse(readFileSync(new URL('../../../../server/test/fixtures/ll2-launch.json', import.meta.url), 'utf8'));
const NET = Date.parse('2026-10-22T22:51:18Z');
const ID = 'f6af629d-39b5-4f86-bc0c-f8776444a858';

const row = (tSec: number, altKm: number, speedKmS: number) => ({ tSec, altKm, speedKmS });
/** a measured-looking ascent that is deliberately ~10% faster than the model */
const liveRows = (until = 120) => [0, 20, 40, 60, 80, 100, 120, 140, 150].filter((t) => t <= until).map((t) =>
  row(t, 0.0006 * t * t * 0.7 + 0.01 * t * 0.2, Math.min(2.4, 0.0001 * t * t * 1.1 + 0.002 * t)));

function setup() {
  const hub = new Hub(0);
  hub.setLaunches([normalizeLaunch(raw(), NET - 3600_000)]);
  syncLaunchEntities(hub, NET - 3600_000);
  return hub;
}

/** what the ingest does with a posted body: validate, merge into the launch's live rows, re-sync the entities */
function ingest(hub: Hub, body: unknown, nowMs = NET - 1000): void {
  const v = validateTelemetryBody(body);
  if (!v.ok) throw new Error(v.error);
  hub.liveTelemetry.set(ID, mergeLive(hub.liveTelemetry.get(ID), v.input, nowMs));
  syncLaunchEntities(hub, nowMs);
}

describe('validateTelemetryBody', () => {
  it('accepts a bare array and sorts and de-duplicates by tSec', () => {
    const v = validateTelemetryBody([row(20, 1, 0.1), row(10, 0.5, 0.05), row(20, 2, 0.2)]);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.input.rows.map((r) => r.tSec)).toEqual([10, 20]);
      expect(v.input.rows[1].altKm).toBe(2); // last duplicate wins
      expect(v.input.replace).toBe(false);
    }
  });

  it('accepts the object form with events, azimuth, source and replace', () => {
    const v = validateTelemetryBody({ rows: [row(1, 0, 0)], events: [{ name: 'MECO', tSec: 151 }], azimuthDeg: 158, source: 'ocr', replace: true });
    expect(v).toMatchObject({ ok: true, input: { azimuthDeg: 158, source: 'ocr', replace: true, events: [{ name: 'MECO', tSec: 151 }] } });
  });

  it.each([
    ['null', null, /array of rows/],
    ['empty', [], /non-empty/],
    ['not an object row', [1], /row 0: not an object/],
    ['string values', [{ tSec: '5', altKm: 1, speedKmS: 1 }], /finite numbers/],
    ['NaN', [{ tSec: 5, altKm: Number.NaN, speedKmS: 1 }], /finite numbers/],
    ['missing field', [{ tSec: 5, altKm: 1 }], /finite numbers/],
    ['negative T+', [row(-1, 0, 0)], /tSec must be within/],
    ['absurd altitude (metres)', [row(5, 9000, 1)], /altKm/],
    ['speed in km/h', [row(5, 1, 4000)], /speedKmS.*km\/s/],
    ['bad event name', { rows: [row(1, 0, 0)], events: [{ name: 'meco', tSec: 1 }] }, /event 0/],
    ['bad azimuth', { rows: [row(1, 0, 0)], azimuthDeg: 400 }, /azimuthDeg/],
    ['bad replace', { rows: [row(1, 0, 0)], replace: 'yes' }, /replace/],
  ])('rejects %s', (_n, body, msg) => {
    const v = validateTelemetryBody(body);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(msg as RegExp);
  });

  it('caps the rows per request', () => {
    const many = Array.from({ length: 2001 }, (_, i) => row(i, 0, 0));
    expect(validateTelemetryBody(many)).toMatchObject({ ok: false });
  });
});

describe('mergeLive', () => {
  const input = (rows: ReturnType<typeof row>[], replace = false) => {
    const v = validateTelemetryBody({ rows, replace });
    if (!v.ok) throw new Error(v.error);
    return v.input;
  };

  it('integrates downrange and merges incrementally, newer rows replacing equal tSec', () => {
    const a = mergeLive(undefined, input([row(0, 0, 0), row(10, 0.5, 0.2)]), 1);
    expect(a.rows[0].downrangeKm).toBe(0);
    expect(a.rows[1].downrangeKm).toBeGreaterThan(0);
    const b = mergeLive(a, input([row(10, 0.6, 0.3), row(20, 2, 0.5)]), 2);
    expect(b.rows.map((r) => r.tSec)).toEqual([0, 10, 20]);
    expect(b.rows[1].altKm).toBe(0.6);
    expect(b.rows[2].downrangeKm).toBeGreaterThan(b.rows[1].downrangeKm);
    expect(mergeLive(b, input([row(5, 0.1, 0.1)], true), 3).rows).toHaveLength(1);
  });
});

describe('a live ascent on the launch entity', () => {
  it('the modeled series before anything is ingested', () => {
    const hub = setup();
    const launch = hub.launches[0];
    const s: AscentSeries = buildSeries(launch, matchTrajectory(hub.trajectories, launch), hub.liveTelemetry.get(ID));
    expect(s).toMatchObject({ launchId: ID, source: 'modeled', liftoffMs: NET, live: null, file: null });
    expect(s.modeled!.label).toMatch(/MODELED/);
    expect(s.modeled!.rows.length).toBeGreaterThan(100);
    expect(s.modeled!.events.map((e) => e.name)).toContain('SECO');
  });

  it('ingested rows replace the modeled path (source live)', () => {
    const hub = setup();
    expect(hub.graph.get(`launch-${ID}`)!.attrs!.trajectorySource).toBe('modeled');
    ingest(hub, { rows: liveRows(100), source: 'test', events: [{ name: 'MECO', tSec: 152 }] });

    const e = hub.graph.get(`launch-${ID}`)!;
    expect(e.attrs).toMatchObject({ trajectorySource: 'live', liveRows: 6, liveLastTSec: 100, liveExtrapolatedFromSec: 100 });
    expect(e.events!.find((ev) => ev.name === 'MECO')).toMatchObject({ tMs: NET + 152_000 });
    expect(e.events!.find((ev) => ev.name === 'MECO')!.detail).toContain('reported');
    expect(e.events!.find((ev) => ev.name === 'MAX_Q')!.detail).toContain('MODELED');

    const p = providerFromSpec(e.provider!) as CompositeProvider;
    const names = (e.provider as any).segments.map((s: any) => s.phase);
    expect(names.slice(0, 3)).toEqual(['pad', 'ascent (live)', 'extrapolated (modeled)']);
    const measured = liveRows(100)[4]; // T+80
    expect(stateToGeodetic(p.stateAt(NET + 80_000)!, NET + 80_000, 'EARTH').alt).toBeCloseTo(measured.altKm, 3);
    expect(p.segmentAt(NET + 50_000)!.phase).toBe('ascent (live)');
    expect(p.segmentAt(NET + 300_000)!.phase).toBe('extrapolated (modeled)');
    expect((p.segmentAt(NET + 300_000)!.spec as any).confidence).toBeLessThan(1);
    // the extrapolation continues from the last measured altitude, with no jump at the hand-over
    const a = stateToGeodetic(p.stateAt(NET + 100_000)!, NET + 100_000, 'EARTH').alt;
    const b = stateToGeodetic(p.stateAt(NET + 102_000)!, NET + 102_000, 'EARTH').alt;
    expect(Math.abs(b - a)).toBeLessThan(2.5);
    // continuous coverage across every join
    for (let t = 0; t <= 1100; t += 0.5) expect(p.stateAt(NET + t * 1000), `t=${t}`).not.toBeNull();

    const s = buildSeries(hub.launches[0], undefined, hub.liveTelemetry.get(ID));
    expect(s.source).toBe('live');
    expect(s.modeled).not.toBeNull();
    expect(s.live).toMatchObject({ lastTSec: 100, extrapolatedFromSec: 100, source: 'test' });
    expect(s.live!.rows).toHaveLength(6);
  });

  it('survives a phase tick: re-syncing keeps the live trajectory', () => {
    const hub = setup();
    ingest(hub, liveRows(60));
    syncLaunchEntities(hub, NET + 30_000);
    expect(hub.graph.get(`launch-${ID}`)!.attrs!.trajectorySource).toBe('live');
  });

  it('merges incremental posts and clearing the live rows restores the modeled path', () => {
    const hub = setup();
    ingest(hub, liveRows(40));
    ingest(hub, [row(60, 8, 0.3), row(80, 14, 0.5)]);
    expect(hub.liveTelemetry.get(ID)!.rows).toHaveLength(5);
    expect(hub.liveTelemetry.get(ID)!.rows[4].tSec).toBe(80);
    hub.liveTelemetry.delete(ID);
    syncLaunchEntities(hub, NET - 1000);
    expect(hub.graph.get(`launch-${ID}`)!.attrs!.trajectorySource).toBe('modeled');
  });

  it('a complete live ascent needs no extrapolation; a file trajectory is replaced by live rows', () => {
    const hub = setup();
    hub.trajectories = [parseTrajectory(JSON.stringify({
      id: 'file-t', match: { launchId: ID }, azimuthDeg: 140,
      rows: [{ tSec: 0, altKm: 0, downrangeKm: 0 }, { tSec: 60, altKm: 10, downrangeKm: 5 }, { tSec: 120, altKm: 50, downrangeKm: 30 }],
    }), 't.json')];
    syncLaunchEntities(hub, NET - 1000);
    expect(hub.graph.get(`launch-${ID}`)!.attrs).toMatchObject({ trajectorySource: 'file', trajectory: 'file-t' });

    const full = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1110].map((t) => row(t, Math.min(165, t * 0.4), Math.min(7.6, t * 0.02)));
    ingest(hub, { rows: full });
    expect(hub.graph.get(`launch-${ID}`)!.attrs).toMatchObject({ trajectorySource: 'live', liveExtrapolatedFromSec: null });
    // past the last measured row the vehicle continues on the modeled orbit instead of returning to the pad
    const p = providerFromSpec(hub.graph.get(`launch-${ID}`)!.provider!) as CompositeProvider;
    expect(p.segmentAt(NET + 1200_000)!.phase).toBe('on orbit (modeled)');
    expect(stateToGeodetic(p.stateAt(NET + 3600_000)!, NET + 3600_000, 'EARTH').alt).toBeGreaterThan(100);
  });

  it('live data starting after liftoff gets a ramped lead-in with no gap or jump', () => {
    const hub = setup();
    ingest(hub, [row(30, 3, 0.2), row(40, 5, 0.3), row(50, 8, 0.4)]);
    const p = providerFromSpec(hub.graph.get(`launch-${ID}`)!.provider!) as CompositeProvider;
    expect(p.segmentAt(NET + 10_000)!.phase).toBe('lead-in (modeled)');
    const g = (t: number) => stateToGeodetic(p.stateAt(NET + t * 1000)!, NET + t * 1000, 'EARTH');
    expect(g(0).alt).toBeCloseTo(0, 3);
    expect(g(30).alt).toBeCloseTo(3, 3);
    expect(Math.abs(g(30.5).alt - g(29.5).alt)).toBeLessThan(0.5);
    expect(g(60).lat / DEG).toBeLessThan(34.632);
  });
});
