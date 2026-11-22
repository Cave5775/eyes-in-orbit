import { readFileSync } from 'node:fs';
import { CompositeProvider, DEG, providerFromSpec, stateToGeodetic, type AscentSeries, type Launch } from '@eio/core';
import { describe, expect, it } from 'vitest';
import { Hub } from '../../src/engine/hub';
import { MemoryKv } from '../../src/engine/store';
import { LIVE_KEY, TelemetryService, buildSeries, mergeLive, planAscent, validateTelemetryBody } from '../../src/engine/telemetry';
import { matchTrajectory, parseTrajectory } from '../../src/engine/trajectory';

// the real LL2 launch is the server's fixture (kept in one place)
const raw = () => JSON.parse(readFileSync(new URL('../fixtures/ll2-launch.json', import.meta.url), 'utf8'));
const NET = Date.parse('2026-10-22T22:51:18Z');
const ID = 'f6af629d-39b5-4f86-bc0c-f8776444a858';

/** The fields of the LL2 fixture the ascent plan reads (the full normalisation belongs to the Launch Library connector). */
function launchFromFixture(): Launch {
  const r = raw();
  const vehicle = r.rocket?.configuration?.full_name ?? r.rocket?.configuration?.name;
  return {
    id: r.id, name: r.name, status: { id: r.status.id, name: r.status.name, abbrev: r.status.abbrev }, net: r.net, vehicle,
    mission: r.mission ? { name: r.mission.name, type: r.mission.type ?? undefined, description: r.mission.description ?? undefined, orbit: r.mission.orbit?.abbrev ?? r.mission.orbit?.name ?? undefined } : undefined,
    pad: { name: r.pad.name, latitude: Number(r.pad.latitude), longitude: Number(r.pad.longitude) },
    streams: [], phase: 'SCHEDULED', entityId: `launch-${r.id}`,
    landing: typeof r.rocket?.launcher_stage?.[0]?.landing?.attempt === 'boolean'
      ? { attempt: r.rocket.launcher_stage[0].landing.attempt, location: r.rocket.launcher_stage[0].landing.landing_location?.abbrev ?? r.rocket.launcher_stage[0].landing.location?.abbrev ?? undefined, type: r.rocket.launcher_stage[0].landing.type?.abbrev ?? undefined }
      : undefined,
  } as unknown as Launch;
}

const row = (tSec: number, altKm: number, speedKmS: number) => ({ tSec, altKm, speedKmS });
/** a measured-looking ascent that is deliberately ~10% faster than the model */
const liveRows = (until = 120) => [0, 20, 40, 60, 80, 100, 120, 140, 150].filter((t) => t <= until).map((t) =>
  row(t, 0.0006 * t * t * 0.7 + 0.01 * t * 0.2, Math.min(2.4, 0.0001 * t * t * 1.1 + 0.002 * t)));

/** A service whose `refresh` plays the connector's sync: it rewrites the launch entity from the plan, as the Launch Library connector does. */
function setup() {
  const hub = new Hub(0);
  const store = new MemoryKv();
  const launch = launchFromFixture();
  hub.setLaunches([launch]);
  const sync = (): void => {
    const plan = planAscent(launch, matchTrajectory(hub.trajectories, launch), hub.liveTelemetry.get(launch.id));
    hub.upsert({
      id: launch.entityId!, name: launch.name, kind: 'launch_vehicle', bodyId: 'EARTH', aliases: { ll2: launch.id }, group: 'launches',
      provider: plan.segments ? { type: 'composite', segments: plan.segments } : undefined, events: plan.events,
      attrs: { trajectorySource: plan.source, liveRows: hub.liveTelemetry.get(launch.id)?.rows.length ?? null, liveExtrapolatedFromSec: plan.extrapolatedFromSec },
    });
    hub.flush();
  };
  sync();
  const svc = new TelemetryService({ hub, store, refresh: sync });
  return { hub, store, svc, sync, launch };
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
    ['NaN', [{ tSec: 5, altKm: Number.NaN, speedKmS: 1 }], /finite numbers/], // serialises to null elsewhere; direct call here
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

describe('TelemetryService', () => {
  const entity = (hub: Hub) => hub.graph.get(`launch-${ID}`)!;

  it('returns the modeled series before anything is ingested', () => {
    const { svc } = setup();
    const s = svc.series(ID) as AscentSeries;
    expect(s).toMatchObject({ launchId: ID, source: 'modeled', liftoffMs: NET, live: null, file: null });
    expect(s.modeled!.label).toMatch(/MODELED/);
    expect(s.modeled!.rows.length).toBeGreaterThan(100);
    expect(s.modeled!.events.map((e) => e.name)).toContain('SECO');
    // `launch-<id>` is accepted too
    expect(svc.series(`launch-${ID}`)?.launchId).toBe(ID);
    expect(svc.series('nope')).toBeUndefined();
  });

  it('ingests rows, replaces the modeled path (source live) and announces the entity change', async () => {
    const { svc, hub, store } = setup();
    expect(entity(hub).attrs!.trajectorySource).toBe('modeled');
    const changed: string[][] = [];
    hub.on('entities.changed', (e) => changed.push(e.ids));

    const res = await svc.ingest(ID, { rows: liveRows(100), source: 'test', events: [{ name: 'MECO', tSec: 152 }] });
    expect(res).toMatchObject({ ok: true, source: 'live', rows: 6, lastTSec: 100, extrapolatedFromSec: 100 });
    expect(changed.flat()).toContain(`launch-${ID}`);

    const e = entity(hub);
    expect(e.attrs).toMatchObject({ trajectorySource: 'live', liveRows: 6, liveExtrapolatedFromSec: 100 });
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

    const s = svc.series(ID)!;
    expect(s.source).toBe('live');
    expect(s.modeled).not.toBeNull();
    expect(s.live!.rows).toHaveLength(6);
    expect(s.live!.lastTSec).toBe(100);
    expect(s.live!.extrapolatedFromSec).toBe(100);
    expect(s.live!.source).toBe('test');

    // persisted for the next run, for 7 days, under telemetry:live:<launch id>
    expect(LIVE_KEY).toBe('telemetry:live:');
    expect((await store.get(`${LIVE_KEY}${ID}`))?.ttlMs).toBe(7 * 86_400_000);
    const hub2 = new Hub(0);
    expect(await new TelemetryService({ hub: hub2, store }).load()).toBe(1);
    expect(hub2.liveTelemetry.get(ID)!.rows).toHaveLength(6);
  });

  it('survives a phase tick: re-syncing keeps the live trajectory', async () => {
    const { svc, hub, sync } = setup();
    await svc.ingest(ID, liveRows(60));
    sync();
    expect(entity(hub).attrs!.trajectorySource).toBe('live');
  });

  it('merges incremental ingests and clear restores the modeled path', async () => {
    const { svc, hub, store } = setup();
    await svc.ingest(ID, liveRows(40));
    expect(await svc.ingest(ID, [row(60, 8, 0.3), row(80, 14, 0.5)])).toMatchObject({ rows: 5, lastTSec: 80 });
    expect(await svc.clear(ID)).toMatchObject({ ok: true, cleared: true });
    expect(entity(hub).attrs!.trajectorySource).toBe('modeled');
    expect(svc.series(ID)!.live).toBeNull();
    expect(await store.get(`${LIVE_KEY}${ID}`)).toBeUndefined();
    expect(await svc.clear(ID)).toMatchObject({ ok: true, cleared: false });
  });

  it('rejects bad bodies and unknown launches, and stores nothing', async () => {
    const { svc, hub, store } = setup();
    const bad = await svc.ingest(ID, [{ tSec: 1, altKm: 1, speedKmS: 99 }]);
    expect(bad).toMatchObject({ ok: false });
    expect(!bad.ok && bad.error).toMatch(/speedKmS/);
    expect(await svc.ingest('nope', liveRows())).toMatchObject({ ok: false, notFound: true });
    expect(await svc.clear('nope')).toMatchObject({ ok: false, notFound: true });
    expect(hub.liveTelemetry.size).toBe(0);
    expect(await store.list(LIVE_KEY)).toEqual([]);
    expect(entity(hub).attrs!.trajectorySource).toBe('modeled');
  });

  it('refuses rows that would exceed the stored cap, keeping what was stored', async () => {
    const { svc, hub } = setup();
    await svc.ingest(ID, { rows: Array.from({ length: 2000 }, (_, i) => row(i, 1, 0.1)) });
    await svc.ingest(ID, { rows: Array.from({ length: 2000 }, (_, i) => row(2000 + i, 1, 0.1)) });
    await svc.ingest(ID, { rows: Array.from({ length: 2000 }, (_, i) => row(4000 + i, 1, 0.1)) });
    const over = await svc.ingest(ID, { rows: Array.from({ length: 2000 }, (_, i) => row(6000 + i % 1201, 1, 0.1)) });
    expect(over).toMatchObject({ ok: false });
    expect(!over.ok && over.error).toMatch(/exceed/);
    expect(hub.liveTelemetry.get(ID)!.rows).toHaveLength(6000);
  });

  it('a complete live ascent needs no extrapolation; a file trajectory is replaced by live rows', async () => {
    const { svc, hub, sync } = setup();
    hub.trajectories = [parseTrajectory(JSON.stringify({
      id: 'file-t', match: { launchId: ID }, azimuthDeg: 140,
      rows: [{ tSec: 0, altKm: 0, downrangeKm: 0 }, { tSec: 60, altKm: 10, downrangeKm: 5 }, { tSec: 120, altKm: 50, downrangeKm: 30 }],
    }), 't.json')];
    sync();
    expect(entity(hub).attrs).toMatchObject({ trajectorySource: 'file' });
    expect(svc.series(ID)).toMatchObject({ source: 'file', file: { id: 'file-t' } });

    const full = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1110].map((t) => row(t, Math.min(165, t * 0.4), Math.min(7.6, t * 0.02)));
    expect(await svc.ingest(ID, { rows: full })).toMatchObject({ source: 'live', extrapolatedFromSec: null });
    expect(entity(hub).attrs).toMatchObject({ trajectorySource: 'live', liveExtrapolatedFromSec: null });
    // past the last measured row the vehicle continues on the modeled orbit instead of returning to the pad
    const p = providerFromSpec(entity(hub).provider!) as CompositeProvider;
    expect(p.segmentAt(NET + 1200_000)!.phase).toBe('on orbit (modeled)');
    expect(stateToGeodetic(p.stateAt(NET + 3600_000)!, NET + 3600_000, 'EARTH').alt).toBeGreaterThan(100);
  });

  it('live data starting after liftoff gets a ramped lead-in with no gap or jump', async () => {
    const { svc, hub } = setup();
    await svc.ingest(ID, [row(30, 3, 0.2), row(40, 5, 0.3), row(50, 8, 0.4)]);
    const p = providerFromSpec(entity(hub).provider!) as CompositeProvider;
    expect(p.segmentAt(NET + 10_000)!.phase).toBe('lead-in (modeled)');
    const g = (t: number) => stateToGeodetic(p.stateAt(NET + t * 1000)!, NET + t * 1000, 'EARTH');
    expect(g(0).alt).toBeCloseTo(0, 3);
    expect(g(30).alt).toBeCloseTo(3, 3);
    expect(Math.abs(g(30.5).alt - g(29.5).alt)).toBeLessThan(0.5);
    expect(g(60).lat / DEG).toBeLessThan(34.632);
  });

  it('buildSeries on a launch without a pad has no path', () => {
    const l = { ...launchFromFixture(), pad: undefined } as Launch;
    expect(buildSeries(l, undefined, undefined)).toMatchObject({ source: null, live: null, file: null });
  });
});

describe('trajectory files', () => {
  const csv = '# id: csv-t\n# launchId: abc\n# azimuthDeg: 120\ntSec,altKm,speedKmS\n0,0,0\n60,10,0.5\n120,50,1.5\n';

  it('parses CSV with speed (downrange integrated) and JSON with downrange, and matches by launch id or name', () => {
    const t = parseTrajectory(csv, 'a.csv');
    expect(t).toMatchObject({ id: 'csv-t', azimuthDeg: 120, match: { launchId: 'abc' } });
    expect(t.rows[2].downrangeKm).toBeGreaterThan(t.rows[1].downrangeKm);
    const j = parseTrajectory(JSON.stringify({ match: { nameContains: 'starlink' }, rows: [{ tSec: 5, altKm: 1, downrangeKm: 0 }, { tSec: 0, altKm: 0, downrangeKm: 0 }] }), 'b.json');
    expect(j.azimuthDeg).toBe(90);
    expect(j.rows.map((r) => r.tSec)).toEqual([0, 5]);
    expect(matchTrajectory([t, j], { id: 'abc', name: 'x' })).toBe(t);
    expect(matchTrajectory([t, j], { id: 'zzz', name: 'Falcon 9 | Starlink 4' })).toBe(j);
    expect(matchTrajectory([t, j], { id: 'zzz', name: 'Atlas' })).toBeUndefined();
  });

  it('rejects files that cannot be used', () => {
    expect(() => parseTrajectory('x', 'a.txt')).toThrow(/unsupported/);
    expect(() => parseTrajectory('{"rows":[]}', 'a.json')).toThrow(/at least 2 rows/);
    expect(() => parseTrajectory(JSON.stringify({ rows: [{ tSec: 0, altKm: 0, downrangeKm: 0 }, { tSec: 1, altKm: 1, downrangeKm: 1 }] }), 'a.json')).toThrow(/match/);
    expect(() => parseTrajectory(JSON.stringify({ match: { launchId: 'x' }, rows: [{ tSec: 0, altKm: 0 }, { tSec: 1, altKm: 1 }] }), 'a.json')).toThrow(/downrangeKm or speedKmS/);
  });
});
