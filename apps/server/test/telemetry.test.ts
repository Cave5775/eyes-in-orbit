import { readFileSync } from 'node:fs';
import { CompositeProvider, DEG, providerFromSpec, stateToGeodetic, type AscentSeries } from '@eio/core';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { LIVE_KEY, loadLiveTelemetry, registerApi } from '../src/api';
import { normalizeLaunch, syncLaunchEntities } from '../src/connectors/launchlibrary';
import { Http } from '../src/http';
import { Hub } from '../src/hub';
import { Store } from '../src/store';
import { isLocalRequest, mergeLive, validateTelemetryBody } from '../src/telemetry';
import { parseTrajectory } from '../src/trajectory';

const raw = () => JSON.parse(readFileSync(new URL('./fixtures/ll2-launch.json', import.meta.url), 'utf8'));
const NET = Date.parse('2026-10-22T22:51:18Z');
const ID = 'f6af629d-39b5-4f86-bc0c-f8776444a858';

const row = (tSec: number, altKm: number, speedKmS: number) => ({ tSec, altKm, speedKmS });
/** a measured-looking ascent that is deliberately ~10% faster than the model */
const liveRows = (until = 120) => [0, 20, 40, 60, 80, 100, 120, 140, 150].filter((t) => t <= until).map((t) =>
  row(t, 0.0006 * t * t * 0.7 + 0.01 * t * 0.2, Math.min(2.4, 0.0001 * t * t * 1.1 + 0.002 * t)));

function setup() {
  const hub = new Hub(0);
  const store = new Store(':memory:');
  hub.setLaunches([normalizeLaunch(raw(), NET - 3600_000)]);
  syncLaunchEntities(hub, NET - 3600_000);
  const app = Fastify();
  registerApi(app, hub, new Http(store, { offline: true }), store);
  return { hub, store, app };
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

describe('isLocalRequest', () => {
  it('accepts loopback sockets without or with a local Origin only', () => {
    expect(isLocalRequest('127.0.0.1')).toBe(true);
    expect(isLocalRequest('::1', 'http://localhost:5173')).toBe(true);
    expect(isLocalRequest('::ffff:127.0.0.1', 'http://127.0.0.1:5173')).toBe(true);
    expect(isLocalRequest('192.168.1.9')).toBe(false);
    expect(isLocalRequest(undefined)).toBe(false);
    expect(isLocalRequest('127.0.0.1', 'https://evil.example')).toBe(false);
    expect(isLocalRequest('127.0.0.1', 'not a url')).toBe(false);
  });
});

describe('POST/GET /api/telemetry/:launchId', () => {
  it('returns the modeled series before anything is posted', async () => {
    const { app } = setup();
    const res = await app.inject({ url: `/api/telemetry/${ID}` });
    expect(res.statusCode).toBe(200);
    const s = res.json() as AscentSeries;
    expect(s).toMatchObject({ launchId: ID, source: 'modeled', liftoffMs: NET, live: null, file: null });
    expect(s.modeled!.label).toMatch(/MODELED/);
    expect(s.modeled!.rows.length).toBeGreaterThan(100);
    expect(s.modeled!.events.map((e) => e.name)).toContain('SECO');
    // `launch-<id>` is accepted too
    expect((await app.inject({ url: `/api/telemetry/launch-${ID}` })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/telemetry/nope' })).statusCode).toBe(404);
  });

  it('ingests rows, replaces the modeled path (source live) and announces the entity change', async () => {
    const { app, hub, store } = setup();
    const before = hub.graph.get(`launch-${ID}`)!;
    expect(before.attrs!.trajectorySource).toBe('modeled');
    const changed: string[][] = [];
    hub.on('entities.changed', (e) => changed.push(e.ids));

    const res = await app.inject({ method: 'POST', url: `/api/telemetry/${ID}`, payload: { rows: liveRows(100), source: 'test', events: [{ name: 'MECO', tSec: 152 }] } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, source: 'live', rows: 6, lastTSec: 100, extrapolatedFromSec: 100 });
    expect(changed.flat()).toContain(`launch-${ID}`);

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

    const s = (await app.inject({ url: `/api/telemetry/${ID}` })).json() as AscentSeries;
    expect(s.source).toBe('live');
    expect(s.modeled).not.toBeNull();
    expect(s.live!.rows).toHaveLength(6);
    expect(s.live!.lastTSec).toBe(100);
    expect(s.live!.extrapolatedFromSec).toBe(100);
    expect(s.live!.source).toBe('test');

    // persisted for the next run
    expect(store.get(`${LIVE_KEY}${ID}`)).toBeDefined();
    const hub2 = new Hub(0);
    expect(loadLiveTelemetry(hub2, store)).toBe(1);
    expect(hub2.liveTelemetry.get(ID)!.rows).toHaveLength(6);
  });

  it('survives a phase tick: re-syncing keeps the live trajectory', async () => {
    const { app, hub } = setup();
    await app.inject({ method: 'POST', url: `/api/telemetry/${ID}`, payload: liveRows(60) });
    syncLaunchEntities(hub, NET + 30_000);
    expect(hub.graph.get(`launch-${ID}`)!.attrs!.trajectorySource).toBe('live');
  });

  it('merges incremental posts and DELETE restores the modeled path', async () => {
    const { app, hub } = setup();
    await app.inject({ method: 'POST', url: `/api/telemetry/${ID}`, payload: liveRows(40) });
    const res = await app.inject({ method: 'POST', url: `/api/telemetry/${ID}`, payload: [row(60, 8, 0.3), row(80, 14, 0.5)] });
    expect(res.json()).toMatchObject({ rows: 5, lastTSec: 80 });
    const del = await app.inject({ method: 'DELETE', url: `/api/telemetry/${ID}` });
    expect(del.json()).toMatchObject({ ok: true, cleared: true });
    expect(hub.graph.get(`launch-${ID}`)!.attrs!.trajectorySource).toBe('modeled');
    expect((await app.inject({ url: `/api/telemetry/${ID}` })).json().live).toBeNull();
  });

  it('rejects bad bodies, unknown launches, non-local callers and cross-origin browsers', async () => {
    const { app, hub } = setup();
    const post = (payload: unknown, extra: Record<string, unknown> = {}) =>
      app.inject({ method: 'POST', url: `/api/telemetry/${ID}`, payload: payload as any, ...extra });

    const bad = await post([{ tSec: 1, altKm: 1, speedKmS: 99 }]);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/speedKmS/);
    expect((await app.inject({ method: 'POST', url: '/api/telemetry/nope', payload: liveRows() })).statusCode).toBe(404);
    expect((await post(liveRows(), { remoteAddress: '10.1.2.3' })).statusCode).toBe(403);
    expect((await post(liveRows(), { headers: { origin: 'https://evil.example' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/telemetry/${ID}`, remoteAddress: '10.1.2.3' })).statusCode).toBe(403);
    // an unparsable body is a client error, never a stored series
    expect((await app.inject({ method: 'POST', url: `/api/telemetry/${ID}`, headers: { 'content-type': 'application/json' }, payload: '{nope' })).statusCode).toBe(400);
    expect(hub.liveTelemetry.size).toBe(0);
    expect(hub.graph.get(`launch-${ID}`)!.attrs!.trajectorySource).toBe('modeled');
  });

  it('a complete live ascent needs no extrapolation; a file trajectory is replaced by live rows', async () => {
    const { app, hub } = setup();
    hub.trajectories = [parseTrajectory(JSON.stringify({
      id: 'file-t', match: { launchId: ID }, azimuthDeg: 140,
      rows: [{ tSec: 0, altKm: 0, downrangeKm: 0 }, { tSec: 60, altKm: 10, downrangeKm: 5 }, { tSec: 120, altKm: 50, downrangeKm: 30 }],
    }), 't.json')];
    syncLaunchEntities(hub, NET - 1000);
    expect(hub.graph.get(`launch-${ID}`)!.attrs).toMatchObject({ trajectorySource: 'file', trajectory: 'file-t' });
    expect((await app.inject({ url: `/api/telemetry/${ID}` })).json()).toMatchObject({ source: 'file', file: { id: 'file-t' } });

    const full = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1110].map((t) => row(t, Math.min(165, t * 0.4), Math.min(7.6, t * 0.02)));
    const res = await app.inject({ method: 'POST', url: `/api/telemetry/${ID}`, payload: { rows: full } });
    expect(res.json()).toMatchObject({ source: 'live', extrapolatedFromSec: null });
    expect(hub.graph.get(`launch-${ID}`)!.attrs).toMatchObject({ trajectorySource: 'live', liveExtrapolatedFromSec: null });
  });

  it('live data starting after liftoff gets a ramped lead-in with no gap or jump', async () => {
    const { app, hub } = setup();
    await app.inject({ method: 'POST', url: `/api/telemetry/${ID}`, payload: [row(30, 3, 0.2), row(40, 5, 0.3), row(50, 8, 0.4)] });
    const p = providerFromSpec(hub.graph.get(`launch-${ID}`)!.provider!) as CompositeProvider;
    expect(p.segmentAt(NET + 10_000)!.phase).toBe('lead-in (modeled)');
    const g = (t: number) => stateToGeodetic(p.stateAt(NET + t * 1000)!, NET + t * 1000, 'EARTH');
    expect(g(0).alt).toBeCloseTo(0, 3);
    expect(g(30).alt).toBeCloseTo(3, 3);
    expect(Math.abs(g(30.5).alt - g(29.5).alt)).toBeLessThan(0.5);
    expect(g(60).lat / DEG).toBeLessThan(34.632);
  });
});
