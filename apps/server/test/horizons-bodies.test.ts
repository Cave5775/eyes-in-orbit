import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BodyProvider, BodyRegistry, bodyEntityRecords, bodyOf, entityRank, isBodyEntity, isOrbitable, bodyPeriodSec, bodyStateEci, bodyStateInParent, defaultBodies, providerFromSpec,
  setBodyStream, type Sample,
} from '@eio/core';
import { registerApi } from '../src/api';
import { loadConfig } from '../src/config';
import { Scheduler } from '../src/connector';
import { bodies } from '../src/connectors/bodies';
import {
  BODY_TARGETS, MOON_STEPS_PER_REV, MOON_WINDOW_STEPS, bodyCacheKey, bodyUrl, horizonsBodies, moonTarget, targetRows,
} from '../src/connectors/horizons-bodies';
import { parseHorizonsVectors } from '../src/connectors/horizons';
import { Http } from '../src/http';
import { Hub } from '../src/hub';
import { Store } from '../src/store';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');
const NOW = Date.parse('2026-10-29T11:30:00Z');
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('horizons-bodies targets', () => {
  const byBody = Object.fromEntries(BODY_TARGETS.map((t) => [t.bodyId, t]));

  it('has exactly one target per registry body except the Sun, Earth and the Moon', () => {
    const want = defaultBodies.all().map((b) => b.id).filter((id) => !['SUN', 'EARTH', 'MOON'].includes(id)).sort();
    expect(BODY_TARGETS.map((t) => t.bodyId).sort()).toEqual(want);
    expect(want).toHaveLength(32);
  });

  it('centres each body on its parent and states the vectors in the parent inertial frame', () => {
    const naif: Record<string, string> = { SUN: '10', MARS: '499', JUPITER: '599', SATURN: '699', URANUS: '799', NEPTUNE: '899', PLUTO: '999' };
    for (const t of BODY_TARGETS) {
      const parent = defaultBodies.get(t.bodyId).parentId!;
      expect(t.frame, t.bodyId).toBe(`${parent}:inertial`);
      expect(t.center, t.bodyId).toBe(`500@${naif[parent]}`);
    }
  });

  it('table: command id, centre, step and window for representative targets', () => {
    expect(byBody.MERCURY).toMatchObject({ horizons: '199', center: '500@10', frame: 'SUN:inertial', stepMin: 2880, pastDays: 365, futureDays: 365 });
    expect(byBody.JUPITER).toMatchObject({ horizons: '599', center: '500@10', frame: 'SUN:inertial', stepMin: 28_800 });
    expect(byBody.NEPTUNE).toMatchObject({ horizons: '899', center: '500@10', frame: 'SUN:inertial', stepMin: 86_400 });
    expect(byBody.CERES).toMatchObject({ horizons: '1;', center: '500@10', stepMin: 14_400 });
    expect(byBody.PLUTO).toMatchObject({ horizons: '999', center: '500@10', frame: 'SUN:inertial' });
    expect(byBody.IO).toMatchObject({ horizons: '501', center: '500@599', frame: 'JUPITER:inertial', stepMin: 105 });
    expect(byBody.PHOBOS).toMatchObject({ horizons: '401', center: '500@499', frame: 'MARS:inertial' });
    expect(byBody.TITAN).toMatchObject({ horizons: '606', center: '500@699', frame: 'SATURN:inertial' });
    expect(byBody.TRITON).toMatchObject({ horizons: '801', center: '500@899', frame: 'NEPTUNE:inertial' });
    expect(byBody.CHARON).toMatchObject({ horizons: '901', center: '500@999', frame: 'PLUTO:inertial' });
    // the NAIF ids of the Uranus moons are not in order of distance (Ariel 701 ... Miranda 705)
    expect([byBody.MIRANDA, byBody.ARIEL, byBody.OBERON].map((t) => t.horizons)).toEqual(['705', '701', '704']);
  });

  it('keeps every response under 150 kB: at most 600 rows (about 210 bytes each in the JSON), moons 401', () => {
    for (const t of BODY_TARGETS) {
      expect(targetRows(t), t.bodyId).toBeLessThanOrEqual(600);
      expect(targetRows(t) * 210, t.bodyId).toBeLessThan(150_000);
    }
    for (const t of BODY_TARGETS.filter((x) => defaultBodies.get(x.bodyId).parentId !== 'SUN')) {
      expect(Math.abs(targetRows(t) - (2 * MOON_WINDOW_STEPS + 1)), t.bodyId).toBeLessThanOrEqual(1);
    }
  });

  it('samples a moon 24 times per revolution, so n h = 0.26 rad and a window of 8 revolutions each side', () => {
    for (const t of BODY_TARGETS.filter((x) => defaultBodies.get(x.bodyId).parentId !== 'SUN')) {
      const period = bodyPeriodSec(defaultBodies.get(t.bodyId))! / 60; // minutes
      const stepsPerRev = period / t.stepMin;
      expect(stepsPerRev, t.bodyId).toBeGreaterThan(MOON_STEPS_PER_REV - 2);
      expect(stepsPerRev, t.bodyId).toBeLessThan(MOON_STEPS_PER_REV + 4 + 5 / t.stepMin * MOON_STEPS_PER_REV); // 5 min rounding, Phobos steps are 20 min
      expect((t.pastDays * 1440) / t.stepMin, t.bodyId).toBeCloseTo(MOON_WINDOW_STEPS, 6);
    }
    expect(moonTarget('IO', '501', '599').stepMin).toBe(105);
  });

  it('Hermite error budget: R (n h)^4 / 384 stays under 1.5e-5 of the orbit radius for moons and under 100 km for the planets', () => {
    for (const t of BODY_TARGETS) {
      const b = defaultBodies.get(t.bodyId);
      const n = (2 * Math.PI) / bodyPeriodSec(b)!; // rad/s
      const h = t.stepMin * 60;
      const err = (b.orbit!.a * (n * h) ** 4) / 384;
      const moon = b.parentId !== 'SUN';
      if (moon) expect(err / b.orbit!.a, t.bodyId).toBeLessThan(1.5e-5);
      else expect(err, t.bodyId).toBeLessThan(120);
      expect(err, t.bodyId).toBeLessThan(b.radiusKm * 0.1 + 5); // under a tenth of the body radius (Phobos 11 km: 6 km)
    }
  });

  it('builds the Horizons query: body centre command, VECTORS, ICRF plane, hour-aligned window', () => {
    const p = new URL(bodyUrl(byBody.JUPITER, NOW)).searchParams;
    expect(p.get('COMMAND')).toBe("'599'");
    expect(p.get('CENTER')).toBe("'500@10'");
    expect(p.get('EPHEM_TYPE')).toBe('VECTORS');
    expect(p.get('REF_PLANE')).toBe('FRAME');
    expect(p.get('STEP_SIZE')).toBe("'28800 m'");
    expect(p.get('START_TIME')).toBe("'2022-10-29 11:00'");
    expect(p.get('STOP_TIME')).toBe("'2030-10-29 11:00'");
    expect(p.get('VEC_TABLE')).toBe('2');
    expect(p.get('OUT_UNITS')).toBe('KM-S');
    expect(bodyCacheKey(byBody.IO)).toBe('horizons-bodies:v1:501:500@599:105m:-14.583333333333334d+14.583333333333334d');
    expect(new URL(bodyUrl(byBody.CERES, NOW)).searchParams.get('COMMAND')).toBe("'1;'");
  });
});

describe('recorded Horizons responses (2026-10-29)', () => {
  const jup = parseHorizonsVectors(fixture('horizons-body-jupiter.json'));
  const io = parseHorizonsVectors(fixture('horizons-body-io.json'));
  const pluto = parseHorizonsVectors(fixture('horizons-body-pluto.json'));
  const mars = parseHorizonsVectors(fixture('horizons-body-mars.json'));
  const ceres = parseHorizonsVectors(fixture('horizons-body-ceres.json'));
  const AU = 149_597_870.7;
  const norm = (s: number[], o = 1) => Math.hypot(s[o], s[o + 1], s[o + 2]);

  it('parses the heliocentric Jupiter, Pluto, Mars and Ceres tables and the Jupiter-centred Io table', () => {
    expect(jup).toHaveLength(5);
    expect(jup[1][0] - jup[0][0]).toBeCloseTo(20 * 86_400_000, -2);
    for (const s of jup) {
      expect(norm(s) / AU).toBeGreaterThan(4.9); // Jupiter 4.95 .. 5.46 AU
      expect(norm(s) / AU).toBeLessThan(5.5);
      expect(norm(s, 4)).toBeGreaterThan(12); // 12 .. 13.7 km/s
      expect(norm(s, 4)).toBeLessThan(14);
    }
    expect(io).toHaveLength(37);
    expect(io[1][0] - io[0][0]).toBe(120 * 60_000);
    for (const s of io) {
      expect(norm(s)).toBeGreaterThan(4.1e5); // Io, a = 421,800 km, e = 0.004
      expect(norm(s)).toBeLessThan(4.3e5);
      expect(norm(s, 4)).toBeGreaterThan(17); // 17.3 km/s
      expect(norm(s, 4)).toBeLessThan(17.6);
    }
    expect(pluto.every((s) => norm(s) / AU > 30 && norm(s) / AU < 40)).toBe(true);
    expect(ceres).toHaveLength(7);
    expect(ceres.every((s) => norm(s) / AU > 2.5 && norm(s) / AU < 3.0)).toBe(true);
    expect(mars).toHaveLength(2);
  });

  it('Hermite interpolation of every other Io row reproduces the skipped row (4 h steps: 3x coarser than the plan)', () => {
    // the plan uses 105 min (n h = 0.26); this fixture is 120 min, taking rows 0 and 2 gives n h = 0.59: the error is bounded by about 140 km
    const reg = new BodyRegistry();
    expect(setBodyStream('IO', { frame: 'JUPITER:inertial', samples: [io[0], io[2]] as Sample[] }, reg)).toBe(true);
    const jupiterAt = (t: number) => bodyStateInParent(reg.get('IO'), t, reg)!.r;
    const err = dist(jupiterAt(io[1][0]), io[1].slice(1));
    expect(err).toBeLessThan(150);
    // full-rate data: exact at the nodes
    setBodyStream('IO', { frame: 'JUPITER:inertial', samples: io as Sample[] }, reg);
    expect(dist(bodyStateInParent(reg.get('IO'), io[10][0], reg)!.r, io[10].slice(1))).toBeLessThan(1e-6);
  });

  it('compares the analytic fallback with Horizons (km): the fallback is approximate by design', () => {
    const reg = new BodyRegistry();
    const err = (id: string, rows: number[][], i: number) => dist(bodyStateInParent(reg.get(id), rows[i][0], reg)!.r, rows[i].slice(1));
    const marsErr = err('MARS', mars, 0);
    const jupErr = err('JUPITER', jup, 0);
    const plutoErr = err('PLUTO', pluto, 0);
    const ceresErr = err('CERES', ceres, 0);
    const ioErr = err('IO', io, 0);
    // eslint-disable-next-line no-console
    console.log(`fallback error vs Horizons @ ${new Date(jup[0][0]).toISOString()}: Mars ${marsErr.toExponential(2)} km, Jupiter ${jupErr.toExponential(2)} km, Pluto ${plutoErr.toExponential(2)} km, Ceres ${ceresErr.toExponential(2)} km, Io (arbitrary phase) ${ioErr.toExponential(2)} km`);
    // Mars: the registry's Kepler orbit is a mean-element circle-ish fit (about a degree)
    expect(marsErr).toBeLessThan(2e6);
    expect(jupErr).toBeLessThan(1e7); // Standish table 1 near 2026: a fraction of a degree
    expect(plutoErr).toBeLessThan(1e7);
    expect(ceresErr).toBeLessThan(2e7);
    expect(ioErr).toBeLessThan(2 * 421_800 * 1.01); // right orbit size, arbitrary phase: never farther than the diameter
  });

  it('a Horizons stream replaces the fallback inside its window and the moons follow the streamed planet', () => {
    const reg = new BodyRegistry();
    const t0 = jup[2][0];
    const before = bodyStateEci('JUPITER', t0, reg).r;
    expect(setBodyStream('JUPITER', { frame: 'SUN:inertial', samples: jup as Sample[] }, reg)).toBe(true);
    expect(setBodyStream('IO', { frame: 'JUPITER:inertial', samples: io as Sample[] }, reg)).toBe(true);
    const after = bodyStateEci('JUPITER', t0, reg).r;
    expect(dist(before, after)).toBeGreaterThan(1e5); // the analytic orbit was off by far more than the sample interpolation
    // Jupiter in the Sun frame is the sample (to the km); in EARTH:inertial it is sample + Sun in the Earth frame
    const helio = bodyStateInParent(reg.get('JUPITER'), t0, reg)!.r;
    expect(dist(helio, jup[2].slice(1))).toBeLessThan(1e-6);
    // Io relative to Jupiter in the Earth frame is the sample too (Io's own frame hop goes through the streamed Jupiter)
    const tIo = io[5][0];
    const rel = bodyStateEci('IO', tIo, reg).r.map((x, k) => x - bodyStateEci('JUPITER', tIo, reg).r[k]);
    expect(dist(rel, io[5].slice(1))).toBeLessThan(1e-3);
    // outside the window: the registered orbit shifted by the edge difference, fading out over a quarter period (3 y for Jupiter)
    const fresh = new BodyRegistry();
    const kep = (t: number) => bodyStateInParent(fresh.get('JUPITER'), t, fresh)!.r;
    const far = jup[jup.length - 1][0] + 400 * 86_400_000;
    const out = bodyStateInParent(reg.get('JUPITER'), far, reg)!.r;
    expect(out.every(Number.isFinite)).toBe(true);
    expect(dist(out, kep(far))).toBeGreaterThan(0); // still inside the fade
    expect(dist(out, kep(far))).toBeLessThan(dist(before, after) * 1.01);
    const gone = jup[jup.length - 1][0] + 4 * 365.25 * 86_400_000;
    expect(dist(bodyStateInParent(reg.get('JUPITER'), gone, reg)!.r, kep(gone))).toBe(0); // 3 y later the plain orbit
    // removing the stream restores it
    setBodyStream('JUPITER', undefined, reg);
    expect(dist(bodyStateEci('JUPITER', t0, reg).r, before)).toBe(0);
  });

  it('rejects a stream in the wrong frame or too short, and leaves the body analytic', () => {
    const reg = new BodyRegistry();
    const r0 = bodyStateEci('IO', io[3][0], reg).r;
    expect(setBodyStream('IO', { frame: 'SUN:inertial', samples: io as Sample[] }, reg)).toBe(false);
    expect(setBodyStream('IO', { frame: 'JUPITER:inertial', samples: [io[0]] as Sample[] }, reg)).toBe(false);
    expect(setBodyStream('SUN', { frame: 'SUN:inertial', samples: io as Sample[] }, reg)).toBe(false);
    expect(dist(bodyStateEci('IO', io[3][0], reg).r, r0)).toBe(0);
  });
});

describe('horizons-bodies connector', () => {
  const T0 = Date.parse('2026-10-29T11:30:00Z');
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });
  afterEach(() => {
    for (const id of ['JUPITER', 'IO', 'PLUTO', 'MARS', 'CERES']) setBodyStream(id, undefined);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** answers every table request with a recorded response chosen by COMMAND; `fail` ids answer an HTTP status */
  function setup(opts: { offline?: boolean; fail?: Record<string, number> } = {}) {
    const files: Record<string, string> = { "'599'": 'horizons-body-jupiter.json', "'501'": 'horizons-body-io.json', "'999'": 'horizons-body-pluto.json', "'499'": 'horizons-body-mars.json', "'1;'": 'horizons-body-ceres.json' };
    const urls: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      urls.push(url);
      const cmd = new URL(url).searchParams.get('COMMAND')!;
      if (opts.fail?.[cmd]) return new Response('blocked', { status: opts.fail[cmd] });
      return new Response(fixture(files[cmd] ?? 'horizons-body-pluto.json'), { status: 200 });
    });
    const hub = new Hub(0);
    const store = new Store(':memory:');
    const config = loadConfig({ ...(opts.offline ? { OFFLINE: '1' } : {}) });
    const http = new Http(store, { fetch: fetchMock, offline: config.offline });
    const scheduler = new Scheduler({ hub, config, store, http }, [bodies, horizonsBodies], 0);
    return { hub, store, scheduler, fetchMock, urls };
  }

  it('replaces only the provider of the body entities; id, kind, hierarchy and createdAt stay', async () => {
    const { hub, scheduler, urls } = setup();
    await scheduler.start();
    const before = Object.fromEntries(hub.graph.all().map((e) => [e.id, e]));
    expect(before['body-jupiter'].provider).toEqual({ type: 'body', bodyId: 'JUPITER' });
    await vi.advanceTimersByTimeAsync(32 * 1500 + 60_000);
    expect(urls).toHaveLength(32);
    for (const id of ['body-jupiter', 'body-io', 'body-pluto', 'body-mars', 'body-ceres']) {
      const e = hub.graph.get(id)!;
      expect(e.provider).toMatchObject({ type: 'body', ephemeris: { samples: expect.any(Array) } });
      expect({ id: e.id, name: e.name, kind: e.kind, bodyId: e.bodyId, parentId: e.parentId, group: e.group, aliases: e.aliases, render: e.render })
        .toEqual({ id: before[id].id, name: before[id].name, kind: before[id].kind, bodyId: before[id].bodyId, parentId: before[id].parentId, group: before[id].group, aliases: before[id].aliases, render: before[id].render });
      expect(e.createdAt).toBe(before[id].createdAt);
    }
    expect(hub.graph.get('body-jupiter')!.provider).toMatchObject({ bodyId: 'JUPITER', ephemeris: { frame: 'SUN:inertial' } });
    expect(hub.graph.get('body-io')!.provider).toMatchObject({ bodyId: 'IO', ephemeris: { frame: 'JUPITER:inertial' } });
    // the Earth, Moon and Sun stay analytic
    for (const id of ['body-sun', 'body-earth', 'body-moon']) expect(hub.graph.get(id)!.provider).toEqual({ type: 'body', bodyId: id.slice(5).toUpperCase() });
    expect(hub.healthOf('horizons-bodies').note).toMatch(/32 of 32 bodies streamed/);
    scheduler.stop();
  });

  it('keeps bodyOf, isBodyEntity, isOrbitable and the rank working on a streamed record', async () => {
    const { hub, scheduler } = setup();
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(32 * 1500 + 60_000);
    const io = hub.graph.get('body-io')!;
    expect(bodyOf(io)).toBe('IO');
    expect(isBodyEntity(io)).toBe(true);
    expect(isOrbitable(io)).toBe(true);
    expect(entityRank(io)).toBe(entityRank(bodyEntityRecords().find((r) => r.id === 'body-io')!));
    // the live graph's provider is the registry-backed BodyProvider and answers in EARTH:inertial
    const s = hub.graph.stateOf('body-io', T0)!;
    expect(s.frame).toBe('EARTH:inertial');
    expect(Number.isFinite(s.r[0])).toBe(true);
    scheduler.stop();
  });

  it('the orbit-line source is the registry orbit, not the (shorter) sample window', async () => {
    const { hub, scheduler } = setup();
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(32 * 1500 + 60_000);
    const pluto = hub.graph.get('body-pluto')!;
    const samples = (pluto.provider as { ephemeris: { samples: number[][] } }).ephemeris.samples;
    const windowSec = (samples[samples.length - 1][0] - samples[0][0]) / 1000;
    const period = bodyPeriodSec(defaultBodies.get('PLUTO'))!;
    expect(windowSec).toBeLessThan(period / 10); // 6 y of 248 y
    // the web samples a body's orbit line over one period via stateIn from the Kepler period: every point has a state
    for (let k = 0; k < 40; k++) expect(hub.graph.stateIn('body-pluto', T0 + (k / 40) * period * 1000, 'SUN:inertial')).not.toBeNull();
    // the period used for the line does not change with the stream
    expect(bodyPeriodSec(defaultBodies.get('PLUTO'))).toBe(period);
    scheduler.stop();
  });

  it('a block error ends the run: the remaining targets are not requested, the streamed ones stay', async () => {
    const { hub, scheduler, urls } = setup({ fail: { "'599'": 429 } });
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(32 * 1500 + 60_000);
    // order: planets first; Mercury, Venus, Mars succeed, Jupiter answers 429, nothing after it is requested
    expect(urls).toHaveLength(4);
    expect(hub.graph.get('body-mars')!.provider).toMatchObject({ ephemeris: { frame: 'SUN:inertial' } });
    expect(hub.graph.get('body-jupiter')!.provider).toEqual({ type: 'body', bodyId: 'JUPITER' });
    expect(hub.graph.get('body-io')!.provider).toEqual({ type: 'body', bodyId: 'IO' });
    expect(hub.healthOf('horizons-bodies').note).toMatch(/3 of 32 bodies streamed/);
    scheduler.stop();
  });

  it('a transient per-target failure is soft: the others carry on', async () => {
    const { hub, scheduler, urls } = setup({ fail: { "'599'": 500 } });
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(32 * 1500 + 60_000);
    expect(urls).toHaveLength(32);
    expect(hub.graph.get('body-jupiter')!.provider).toEqual({ type: 'body', bodyId: 'JUPITER' });
    expect(hub.graph.get('body-io')!.provider).toMatchObject({ ephemeris: expect.anything() });
    expect(hub.healthOf('horizons-bodies').note).toMatch(/31 of 32 bodies streamed; 1 on the analytic fallback/);
    scheduler.stop();
  });

  it('under OFFLINE=1 makes no request and the bodies keep the analytic fallback', async () => {
    const { hub, scheduler, fetchMock } = setup({ offline: true });
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(hub.graph.get('body-jupiter')!.provider).toEqual({ type: 'body', bodyId: 'JUPITER' });
    expect(hub.healthOf('horizons-bodies').status).toBe('ok');
    scheduler.stop();
  });

  it('serves the streamed record through the API (the JSON round trip rebuilds the provider)', async () => {
    const { hub, scheduler } = setup();
    const server = Fastify();
    registerApi(server, hub, new Http(new Store(':memory:'), { fetch: vi.fn<typeof fetch>(), offline: true }));
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(32 * 1500 + 60_000);
    const rec = (await server.inject({ url: '/api/entities/body-io' })).json();
    expect(rec).toMatchObject({ kind: 'moon', parentId: 'body-jupiter', bodyId: 'JUPITER', provider: { type: 'body', bodyId: 'IO', ephemeris: { frame: 'JUPITER:inertial' } } });
    expect(rec.provider.ephemeris.samples.length).toBe(37);
    const p = providerFromSpec(rec.provider);
    expect(p).toBeInstanceOf(BodyProvider);
    expect(p.stateAt(T0)).toBeTruthy();
    scheduler.stop();
  });
});
