import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineConfig } from '../../../src/engine/config';
import { DEFAULT_HORIZONS, activeTargets, probeId } from '../../../src/engine/connectors/dsn-targets';
import { HORIZONS_FUTURE_DAYS, HORIZONS_PAST_DAYS, horizons, horizonsCacheKey, horizonsUrl, parseHorizonsVectors } from '../../../src/engine/connectors/horizons';
import { Http } from '../../../src/engine/http';
import { Hub } from '../../../src/engine/hub';
import { Limiter } from '../../../src/engine/net/limiter';
import { LIMITS } from '../../../src/engine/net/limits';
import { applyUpstream, defaultUpstreams, resolveUpstream, setUpstreams } from '../../../src/engine/net/upstream';
import { Scheduler } from '../../../src/engine/scheduler';
import { MemoryKv } from '../../../src/engine/store';

// a trimmed real Horizons response, shared with the server's tests by path
const fx = (name: string): string => readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), 'utf8');
const MIN = 60_000;
const T0 = Date.parse('2026-11-01T10:00:00Z');

describe('horizons request and parse', () => {
  it('asks for ICRF vectors around the fetch hour and keys the cache by target, centre, step and window', () => {
    const url = new URL(horizonsUrl('-61', T0 + 25 * MIN));
    expect(`${url.origin}${url.pathname}`).toBe('https://ssd.jpl.nasa.gov/api/horizons.api');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      format: 'json', COMMAND: "'-61'", EPHEM_TYPE: 'VECTORS', CENTER: "'500@399'", REF_PLANE: 'FRAME', STEP_SIZE: "'30 m'", VEC_TABLE: '2', CSV_FORMAT: 'YES', OUT_UNITS: 'KM-S',
      START_TIME: "'2026-10-29 10:00'", STOP_TIME: "'2026-11-08 10:00'",
    });
    expect(HORIZONS_PAST_DAYS).toBe(DEFAULT_HORIZONS.pastDays);
    expect(HORIZONS_FUTURE_DAYS).toBe(DEFAULT_HORIZONS.futureDays);
    expect(horizonsCacheKey('-61')).toBe('horizons:v2:-61:500@399:30m:-3d+7d');
  });

  it('parses the vector table to [t, x, y, z, vx, vy, vz] rows and refuses a response without one', () => {
    const rows = parseHorizonsVectors(fx('horizons-vectors.json'));
    expect(rows.length).toBeGreaterThan(2);
    expect(rows[0]).toHaveLength(7);
    expect(rows.every((r) => r.every(Number.isFinite))).toBe(true);
    expect(() => parseHorizonsVectors(fx('horizons-noephem.json'))).toThrow(/no ephemeris/);
    expect(() => parseHorizonsVectors('{"result":"$$SOE\\n$$EOE"}')).toThrow(/malformed|no ephemeris/);
  });
});

describe('horizons connector (relay, real limit table)', () => {
  beforeEach(() => {
    setUpstreams(defaultUpstreams());
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function setup(answer: (url: string) => Response) {
    const hub = new Hub(0);
    const store = new MemoryKv();
    const limiter = new Limiter(store, { limits: LIMITS });
    const calls: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => (calls.push(String(input)), answer(String(input))));
    const http = new Http(store, { fetch: fetchMock, limiter });
    const scheduler = new Scheduler({ hub, config: engineConfig(), store, http }, [horizons], 0);
    return { hub, store, limiter, calls, scheduler };
  }

  it('one request at a time, 1.5 s apart, on `horizons`, through the relay', async () => {
    const { limiter, calls, scheduler, hub } = setup(() => new Response(fx('horizons-vectors.json')));
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);
    scheduler.stop();
    expect(calls.length).toBeGreaterThan(5);
    expect(calls.every((u) => u.startsWith('/relay?url=https%3A%2F%2Fssd.jpl.nasa.gov%2Fapi%2Fhorizons.api%3F'))).toBe(true);
    expect(await limiter.status('horizons')).toMatchObject({ used: calls.length, cap: 120 });
    expect((await limiter.state('horizons')).nextAllowedAt - (Date.now() - 1)).toBeLessThanOrEqual(1500);
    // every answered target got a sampled provider in its entity
    const [code] = activeTargets()[0];
    expect(hub.graph.get(probeId(code))!.provider).toMatchObject({ type: 'sampled' });
    // the relay URL carries the very request the connector builds
    const [, target] = activeTargets()[0];
    expect(calls[0]).toBe(applyUpstream(resolveUpstream('horizons'), horizonsUrl(target.horizons, T0, { ...DEFAULT_HORIZONS, ...target } as never)));
  });

  it.each([
    [429, '1800', 30 * MIN], [503, '1200', 20 * MIN], [502, undefined, 15 * MIN], [504, undefined, 15 * MIN],
  ])('a relay %i blocks Horizons (Retry-After %s honoured, at least 15 min) and the other targets are not requested', async (status, retryAfter, minBlock) => {
    const { limiter, calls, scheduler, hub } = setup(() => new Response('{"error":"x","stage":"query"}', { status, headers: retryAfter ? { 'retry-after': retryAfter } : {} }));
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(30_000);
    scheduler.stop();
    expect(calls).toHaveLength(1);
    const blocked = (await limiter.state('horizons')).blockedUntil!;
    expect(blocked - T0).toBeGreaterThanOrEqual(minBlock);
    expect(blocked - T0).toBeLessThan(minBlock + 30_000);
    expect(hub.healthOf('horizons').status).toBe('error');
  });
});
