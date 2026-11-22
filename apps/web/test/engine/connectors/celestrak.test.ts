import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { launchIdFromCospar } from '@eio/core';
import { backoffKey, readBackoff } from '../../../src/engine/backoff';
import { AMATEUR_GROUP, DEBRIS_GROUPS, NAV_GROUPS, OPAQUE_GATE_MS, celestrakUrl, createCelestrak, isOpaqueFailure, normalizeCelestrak, parseOmmJson, satKind } from '../../../src/engine/connectors/celestrak';
import { Http } from '../../../src/engine/http';
import { Limiter } from '../../../src/engine/net/limiter';
import { defaultUpstreams, setUpstreams, type UpstreamTable } from '../../../src/engine/net/upstream';
import { MemoryKv } from '../../../src/engine/store';

// trimmed real CelesTrak responses, shared with the server's tests by path
const fixture = (name: string) => readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), 'utf8');
const groups = () => ({
  stations: parseOmmJson(fixture('celestrak-stations.json')),
  starlink: parseOmmJson(fixture('celestrak-starlink.json')),
  active: parseOmmJson(fixture('celestrak-active.json')),
});
const debrisGroups = () => ({
  'cosmos-2251-debris': parseOmmJson(fixture('celestrak-cosmos-2251-debris.json')),
  'iridium-33-debris': parseOmmJson(fixture('celestrak-iridium-33-debris.json')),
});

describe('celestrak normalize', () => {
  it('parses OMM JSON down to the SGP4 fields', () => {
    const [iss] = groups().stations;
    expect(iss).toMatchObject({ OBJECT_NAME: 'ISS (ZARYA)', NORAD_CAT_ID: 25544, MEAN_MOTION: 15.48967427 });
    expect(Object.keys(iss)).toHaveLength(17);
  });

  it('rejects non-array responses (CelesTrak sends text on errors)', () => {
    expect(() => parseOmmJson('{"error":"x"}')).toThrow(/JSON array/);
    expect(() => parseOmmJson('GP data has not updated')).toThrow();
  });

  it('dedupes by NORAD id, preferring stations > starlink > active', () => {
    const entities = normalizeCelestrak(groups());
    const ids = entities.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(['sat-33591', 'sat-44714', 'sat-48274', 'sat-49271', 'sat-5730', 'sat-25544'].sort());
    expect(entities.find((e) => e.id === 'sat-25544')!.group).toBe('stations');
    expect(entities.find((e) => e.id === 'sat-44714')!.group).toBe('starlink');
    expect(entities.find((e) => e.id === 'sat-33591')!.group).toBe('active');
  });

  it('keeps Starlink satellites listed in `active` in the starlink group and colour', () => {
    const omm = { ...groups().starlink[0], NORAD_CAT_ID: 99999, OBJECT_NAME: 'STARLINK-1234' };
    const e = normalizeCelestrak({ active: [omm] })[0];
    expect(e).toMatchObject({ id: 'sat-99999', group: 'starlink', render: { colorKey: 'starlink' } });
  });

  it('builds sgp4 entities with aliases and render keys', () => {
    const byId = Object.fromEntries(normalizeCelestrak(groups()).map((e) => [e.id, e]));
    expect(byId['sat-25544']).toMatchObject({
      name: 'ISS (ZARYA)', kind: 'station', bodyId: 'EARTH', aliases: { norad: '25544', cospar: '1998-067A', common: 'ISS' },
      provider: { type: 'sgp4' }, render: { colorKey: 'station', footprint: true, orbitLine: true, trailSeconds: 5400, model: 'iss' },
    });
    expect(byId['sat-25544'].links!.streams!.some((s) => s.kind === 'youtube')).toBe(true);
    expect(byId['sat-44714'].render).toEqual({ colorKey: 'starlink' });
    expect(byId['sat-33591'].render).toEqual({ colorKey: 'satellite' });
    expect(byId['sat-49271'].render).toEqual({ colorKey: 'debris' });
  });

  it('classifies kinds', () => {
    const by = (n: string) => groups().active.concat(groups().stations).find((o) => o.OBJECT_NAME === n)!;
    expect(satKind(by('ISS (ZARYA)'))).toBe('station');
    expect(satKind(by('CSS (TIANHE)'))).toBe('station');
    expect(satKind(by('FREGAT DEB'))).toBe('debris');
    expect(satKind(by('SL-8 R/B'))).toBe('debris');
    expect(satKind(by('NOAA 19'))).toBe('satellite');
  });
});

describe('celestrak debris groups', () => {
  it('lists the verified CelesTrak GROUP names', () => {
    expect([...DEBRIS_GROUPS]).toEqual(['cosmos-2251-debris', 'iridium-33-debris', 'fengyun-1c-debris']);
  });

  it('tags debris-cloud objects with their CelesTrak group, kind debris and the debris colour', () => {
    const entities = normalizeCelestrak({ ...groups(), ...debrisGroups() });
    const byId = Object.fromEntries(entities.map((e) => [e.id, e]));
    expect(byId['sat-33791']).toMatchObject({
      name: 'COSMOS 2251 DEB', kind: 'debris', group: 'cosmos-2251-debris', aliases: { norad: '33791', cospar: '1993-036BQ' },
      render: { colorKey: 'debris' },
    });
    expect(byId['sat-24946']).toMatchObject({ kind: 'debris', group: 'iridium-33-debris', render: { colorKey: 'debris' } });
    // the defunct parent has no DEB in its name but is still debris inside a debris-cloud group
    expect(byId['sat-22675']).toMatchObject({ name: 'COSMOS 2251', kind: 'debris', group: 'cosmos-2251-debris' });
    // existing groups are unaffected
    expect(byId['sat-33591'].group).toBe('active');
    expect(byId['sat-33591'].kind).toBe('satellite');
  });

  it('gives a debris-cloud group priority over active, but not over stations or starlink', () => {
    const g = groups();
    const deb = debrisGroups();
    const dupInActive = { ...deb['cosmos-2251-debris'][1] }; // 33791 also listed in `active`
    const dupInStarlink = { ...deb['iridium-33-debris'][0] }; // 24946 also listed in `starlink`
    const entities = normalizeCelestrak({
      ...g, ...deb, active: [...g.active, dupInActive], starlink: [...g.starlink, dupInStarlink],
    });
    const ids = entities.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(entities.find((e) => e.id === 'sat-33791')!.group).toBe('cosmos-2251-debris');
    expect(entities.find((e) => e.id === 'sat-24946')!.group).toBe('starlink');
    expect(entities.find((e) => e.id === 'sat-25544')!.group).toBe('stations');
  });

  it('keeps a debris object tagged by `active` only when no debris group was fetched (partial failure)', () => {
    const g = groups();
    const dup = { ...debrisGroups()['cosmos-2251-debris'][1] };
    const e = normalizeCelestrak({ ...g, active: [...g.active, dup] }).find((x) => x.id === 'sat-33791')!;
    expect(e.group).toBe('active');
    expect(e.kind).toBe('debris'); // still debris by name
  });

  it('all members of a cloud share the launch id derived from their COSPAR', () => {
    const e = normalizeCelestrak(debrisGroups()).filter((x) => x.group === 'cosmos-2251-debris');
    expect(e).toHaveLength(3);
    expect(new Set(e.map((x) => launchIdFromCospar(x.aliases.cospar)))).toEqual(new Set(['1993-036']));
  });
});

describe('celestrak navigation and amateur groups', () => {
  const nav = () => ({
    'gps-ops': parseOmmJson(fixture('celestrak-gps-ops.json')),
    galileo: parseOmmJson(fixture('celestrak-galileo.json')),
  });
  const amateur = () => parseOmmJson(fixture('celestrak-amateur.json'));

  it('lists the CelesTrak GROUP names', () => {
    expect([...NAV_GROUPS]).toEqual(['gps-ops', 'glo-ops', 'galileo', 'beidou']);
    expect(AMATEUR_GROUP).toBe('amateur');
  });

  it('tags navigation satellites with their group and the navigation colour (kind stays satellite)', () => {
    const byId = Object.fromEntries(normalizeCelestrak({ ...groups(), ...nav() }).map((e) => [e.id, e]));
    expect(byId['sat-27663']).toMatchObject({
      name: 'GPS BIIR-8  (PRN 16)', kind: 'satellite', group: 'gps-ops', aliases: { norad: '27663', cospar: '2003-005A' },
      provider: { type: 'sgp4' }, render: { colorKey: 'navigation' },
    });
    expect(byId['sat-37846']).toMatchObject({ kind: 'satellite', group: 'galileo', render: { colorKey: 'navigation' } });
    // existing groups are unaffected
    expect(byId['sat-33591'].render).toEqual({ colorKey: 'satellite' });
    expect(byId['sat-44714'].render).toEqual({ colorKey: 'starlink' });
  });

  it('keeps amateur satellites in the plain satellite colour but in their own group', () => {
    const e = normalizeCelestrak({ amateur: amateur() })[0];
    expect(e).toMatchObject({ id: 'sat-43017', kind: 'satellite', group: 'amateur', render: { colorKey: 'satellite' } });
  });

  it('classifies a satellite listed in both `active` and a navigation group as navigation', () => {
    const g = groups();
    const gps = nav()['gps-ops'];
    const inActive = { ...gps[0] }; // 27663 also in `active`
    const entities = normalizeCelestrak({ ...g, ...nav(), active: [...g.active, inActive] });
    const ids = entities.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(entities.find((e) => e.id === 'sat-27663')).toMatchObject({ group: 'gps-ops', render: { colorKey: 'navigation' } });
    // when the navigation group could not be fetched the satellite stays a plain `active` one
    expect(normalizeCelestrak({ ...g, active: [...g.active, inActive] }).find((e) => e.id === 'sat-27663')).toMatchObject({
      group: 'active', render: { colorKey: 'satellite' },
    });
  });

  it('keeps stations, Starlink and debris clouds ahead of navigation and amateur groups', () => {
    const g = groups();
    const iss = { ...g.stations[0] };
    const sl = { ...g.starlink[0] };
    const cloud = debrisGroups()['cosmos-2251-debris'][1];
    const entities = normalizeCelestrak({
      ...g, ...debrisGroups(), 'gps-ops': [iss, sl, { ...cloud }], amateur: [{ ...iss }, { ...cloud }],
    });
    expect(entities.find((e) => e.id === 'sat-25544')!.group).toBe('stations');
    expect(entities.find((e) => e.id === 'sat-44714')!.group).toBe('starlink');
    expect(entities.find((e) => e.id === 'sat-33791')).toMatchObject({ group: 'cosmos-2251-debris', render: { colorKey: 'debris' } });
  });

  it('prefers navigation over amateur', () => {
    const omm = { ...amateur()[0] };
    const entities = normalizeCelestrak({ amateur: [omm], galileo: [omm] });
    expect(entities).toHaveLength(1);
    expect(entities[0]).toMatchObject({ group: 'galileo', render: { colorKey: 'navigation' } });
  });
});

describe('celestrak connector run', () => {
  const fast = createCelestrak();
  /** groups the fake CelesTrak answers with HTTP 403 (set by `fakeCtx(block)`) */
  let blocked = new Set<string>();
  const body = (group: string): string => {
    if (blocked.has(group)) throw new Error('HTTP 403');
    if (group === 'stations') return fixture('celestrak-stations.json');
    if (group === 'starlink') return fixture('celestrak-starlink.json');
    if (group === 'active') return fixture('celestrak-active.json');
    if (group === 'cosmos-2251-debris') return fixture('celestrak-cosmos-2251-debris.json');
    if (group === 'iridium-33-debris') return fixture('celestrak-iridium-33-debris.json');
    if (group === 'gps-ops' || group === 'galileo' || group === 'amateur') return fixture(`celestrak-${group}.json`);
    // distinct objects for the other two navigation groups, derived from the Galileo fixture
    if (group === 'glo-ops') return JSON.stringify(parseOmmJson(fixture('celestrak-galileo.json')).map((o) => ({ ...o, OBJECT_NAME: 'COSMOS 2545 (GLONASS-K2)', NORAD_CAT_ID: 45358 })));
    if (group === 'beidou') return JSON.stringify(parseOmmJson(fixture('celestrak-galileo.json')).map((o) => ({ ...o, OBJECT_NAME: 'BEIDOU-3 M1', NORAD_CAT_ID: 43001 })));
    if (group === 'fengyun-1c-debris') return JSON.stringify(parseOmmJson(fixture('celestrak-iridium-33-debris.json')).map((o) => ({ ...o, OBJECT_NAME: 'FENGYUN 1C DEB', NORAD_CAT_ID: o.NORAD_CAT_ID + 100000 })));
    throw new Error('HTTP 403');
  };
  function fakeCtx(block: string[] = []) {
    blocked = new Set(block);
    const calls: { key: string; url: string; headers?: Record<string, string> }[] = [];
    const upserted: { id: string; group?: string }[] = [];
    const soft: { msg: string; retry?: number }[] = [];
    const ctx = {
      calls, upserted, soft,
      store: new MemoryKv(),
      health: {} as { note?: string },
      log: () => {},
      hub: { graph: { size: 0 }, upsert: (...r: { id: string; group?: string }[]) => (upserted.push(...r), r.length) },
      softFail: (msg: string, retry?: number) => void soft.push({ msg, retry }),
      cachedFetch: async <T>(key: string, url: string, _ttl: number, parse: (t: string) => T, headers?: Record<string, string>) => {
        calls.push({ key, url, headers });
        const group = key.replace('celestrak:', '');
        return { value: parse(body(group)), fromCache: false, stale: false };
      },
    };
    return ctx;
  }

  it('requests every group once, each under its own cache key', async () => {
    const ctx = fakeCtx();
    await fast.run!(ctx as never);
    expect(ctx.calls.map((c) => c.key)).toEqual([
      'celestrak:stations', 'celestrak:starlink', 'celestrak:active',
      'celestrak:cosmos-2251-debris', 'celestrak:iridium-33-debris', 'celestrak:fengyun-1c-debris',
      'celestrak:gps-ops', 'celestrak:glo-ops', 'celestrak:galileo', 'celestrak:beidou', 'celestrak:amateur',
    ]);
    expect(ctx.calls.find((c) => c.key === 'celestrak:gps-ops')!.url).toBe(
      'https://celestrak.org/NORAD/elements/gp.php?GROUP=gps-ops&FORMAT=json',
    );
    expect(ctx.calls.find((c) => c.key === 'celestrak:iridium-33-debris')!.url).toBe(
      'https://celestrak.org/NORAD/elements/gp.php?GROUP=iridium-33-debris&FORMAT=json',
    );
  });

  it('reports a partial failure when a debris group is blocked, and leaves the groups after it alone', async () => {
    const ctx = fakeCtx(['fengyun-1c-debris']);
    await fast.run!(ctx as never);
    expect(ctx.calls.map((c) => c.key)).not.toContain('celestrak:gps-ops'); // a block stops the run
    expect(ctx.upserted.some((e) => e.group === 'cosmos-2251-debris')).toBe(true);
    expect(ctx.upserted.some((e) => e.group === 'fengyun-1c-debris')).toBe(false);
    expect(ctx.health.note).toMatch(/^partial: fengyun-1c-debris: /);
    // a 403 closes that group's gate for 3 h, so the next attempt matches the normal interval
    expect(ctx.soft).toHaveLength(1);
    expect(ctx.soft[0].msg).toContain('fengyun-1c-debris');
    expect(ctx.soft[0].retry!).toBeGreaterThan(2.9 * 3600_000);
    expect(ctx.soft[0].retry!).toBeLessThanOrEqual(3 * 3600_000);
    expect(await readBackoff(ctx.store, 'celestrak:fengyun-1c-debris')).toMatchObject({ failures: 1, message: 'HTTP 403' });
  });

  it('does not touch the network for a group whose gate is closed, even in a new run (restart)', async () => {
    const ctx = fakeCtx(['fengyun-1c-debris']);
    await fast.run!(ctx as never);
    ctx.calls.length = 0;
    await fast.run!(ctx as never); // same store = same process restarted
    expect(ctx.calls.map((c) => c.key)).not.toContain('celestrak:fengyun-1c-debris');
  });

  it('serves a blocked group from its stale cache entry and keeps the gate shut', async () => {
    const ctx = fakeCtx();
    await ctx.store.put('celestrak:starlink', parseOmmJson(fixture('celestrak-starlink.json')), 1, 0); // long expired
    await ctx.store.put(backoffKey('celestrak:starlink'), { failures: 1, notBefore: Date.now() + 3600_000, message: 'HTTP 403' }, 1e9);
    await fast.run!(ctx as never);
    expect(ctx.calls.map((c) => c.key)).not.toContain('celestrak:starlink');
    expect(ctx.upserted.some((e) => e.group === 'starlink')).toBe(true);
    expect(ctx.health.note).toMatch(/starlink: waiting until \d\d:\d\dZ \(HTTP 403\), using cache/);
  });

  it('falls back to an expired cache row for a navigation group when CelesTrak fails, and keeps its colour', async () => {
    const ctx = fakeCtx();
    ctx.cachedFetch = (async (key: string) => {
      if (key === 'celestrak:gps-ops') throw new Error('HTTP 403 for https://celestrak.org/x');
      return { value: parseOmmJson(body(key.replace('celestrak:', ''))), fromCache: false, stale: false };
    }) as never;
    await ctx.store.put('celestrak:gps-ops', parseOmmJson(fixture('celestrak-gps-ops.json')), 1, 0); // long expired
    const upserted: { id: string; group?: string; render?: { colorKey?: string } }[] = [];
    ctx.hub.upsert = ((...r: typeof upserted) => (upserted.push(...r), r.length)) as never;
    await fast.run!(ctx as never);
    expect(upserted.find((e) => e.id === 'sat-27663')).toMatchObject({ group: 'gps-ops', render: { colorKey: 'navigation' } });
    expect(ctx.health.note).toMatch(/gps-ops: HTTP 403.*using cache/);
  });

  it('clears the gate once a download works again', async () => {
    const ctx = fakeCtx();
    await ctx.store.put(backoffKey('celestrak:starlink'), { failures: 2, notBefore: 1 }, 1e9); // expired gate
    await fast.run!(ctx as never);
    expect(await readBackoff(ctx.store, 'celestrak:starlink')).toBeUndefined();
  });

  it('still throws when every group fails', async () => {
    const ctx = fakeCtx();
    ctx.cachedFetch = (async () => { throw new Error('HTTP 403'); }) as never;
    await expect(fast.run!(ctx as never)).rejects.toThrow(/stations: HTTP 403/);
  });

  it('a hidden (CORS) failure earns only the short gate, stops the run after one request and never a 30 min to 12 h backoff', async () => {
    const ctx = fakeCtx();
    ctx.cachedFetch = (async (key: string, url: string) => {
      ctx.calls.push({ key, url });
      throw new TypeError('Failed to fetch');
    }) as never;
    await expect(fast.run!(ctx as never)).rejects.toThrow(/Failed to fetch/);
    expect(ctx.calls).toHaveLength(1);
    const gate = (await readBackoff(ctx.store, 'celestrak:stations'))!;
    expect(gate.failures).toBe(1);
    expect(gate.notBefore - Date.now()).toBeLessThanOrEqual(OPAQUE_GATE_MS);
    expect(gate.notBefore - Date.now()).toBeGreaterThan(OPAQUE_GATE_MS - 5000);
    // a second hidden failure does not escalate
    await ctx.store.put(backoffKey('celestrak:stations'), { failures: 1, notBefore: 1 }, 1e9);
    await expect(fast.run!(ctx as never)).rejects.toThrow();
    expect((await readBackoff(ctx.store, 'celestrak:stations'))!.failures).toBe(1);
    expect(isOpaqueFailure('Failed to fetch')).toBe(true);
    expect(isOpaqueFailure('HTTP 403 for https://celestrak.org/x')).toBe(false);
    expect(isOpaqueFailure('fetch failed (UND_ERR_CONNECT_TIMEOUT)')).toBe(false);
  });

  it('switching the route (direct <-> relay) clears the per-group gates; staying on the same route keeps them', async () => {
    const prev = setUpstreams({});
    try {
      const ctx = fakeCtx();
      const gate = { failures: 3, notBefore: Date.now() + 3600_000, message: 'HTTP 403' };
      await fast.run!(ctx as never); // first run records the route: direct
      await ctx.store.put(backoffKey('celestrak:starlink'), gate, 1e9);
      await fast.run!(ctx as never);
      expect(await readBackoff(ctx.store, 'celestrak:starlink')).toMatchObject({ failures: 3 }); // same route: kept
      setUpstreams(defaultUpstreams({ celestrakViaRelay: true }));
      ctx.calls.length = 0;
      await fast.run!(ctx as never);
      expect(await readBackoff(ctx.store, 'celestrak:starlink')).toBeUndefined();
      expect(ctx.calls.map((c) => c.key)).toContain('celestrak:starlink'); // and the group is requested again
    } finally {
      setUpstreams(prev);
    }
  });

  const connectTimeout = new Error('fetch failed (UND_ERR_CONNECT_TIMEOUT)');

  it('stops the run after the first connect timeout: one request, one summary line, no gate for the skipped groups', async () => {
    const ctx = fakeCtx();
    const lines: string[] = [];
    ctx.log = ((m: string) => void lines.push(m)) as never;
    await ctx.store.put('celestrak:active', parseOmmJson(fixture('celestrak-active.json')), 1, 0); // cached, long expired
    ctx.cachedFetch = (async (key: string, url: string) => {
      ctx.calls.push({ key, url });
      if (key === 'celestrak:stations') {
        return { value: parseOmmJson(fixture('celestrak-stations.json')), fromCache: false, stale: false };
      }
      throw connectTimeout; // starlink is the first to fail
    }) as never;
    await fast.run!(ctx as never);
    expect(ctx.calls.map((c) => c.key)).toEqual(['celestrak:stations', 'celestrak:starlink']);
    // the failing group has its gate (the short schedule: a dead host may be an outage), the skipped ones have none
    const gate = (await readBackoff(ctx.store, 'celestrak:starlink'))!;
    expect(gate.message).toContain('UND_ERR_CONNECT_TIMEOUT');
    expect(gate.notBefore - Date.now()).toBeGreaterThan(0.4 * 3600_000);
    expect(gate.notBefore - Date.now()).toBeLessThan(0.6 * 3600_000);
    for (const g of ['active', 'gps-ops', 'amateur']) expect(await readBackoff(ctx.store, 'celestrak:' + g)).toBeUndefined();
    // one summary entry for the nine skipped groups, with where their data came from
    expect(lines).toHaveLength(1);
    expect(lines[0].match(/skipped 9 groups/g)).toHaveLength(1);
    expect(lines[0]).toContain('active (cache)');
    expect(lines[0]).toContain('beidou (no data)');
    expect(ctx.health.note).toMatch(/^partial: starlink: fetch failed \(UND_ERR_CONNECT_TIMEOUT\);/);
    expect(ctx.upserted.some((e) => e.group === 'stations')).toBe(true);
    expect(ctx.soft).toHaveLength(1);
    expect(ctx.soft[0].retry!).toBeGreaterThan(0.4 * 3600_000);
  });

  it('with nothing loaded, a first-group connect timeout throws a single error naming the skipped groups', async () => {
    const ctx = fakeCtx();
    ctx.cachedFetch = (async (key: string, url: string) => {
      ctx.calls.push({ key, url });
      throw connectTimeout;
    }) as never;
    await expect(fast.run!(ctx as never)).rejects.toThrow(/^stations: fetch failed \(UND_ERR_CONNECT_TIMEOUT\); skipped 10 groups/);
    expect(ctx.calls).toHaveLength(1);
    expect(await readBackoff(ctx.store, 'celestrak:starlink')).toBeUndefined();
  });

  it('stays off the network in later runs while a connect-error gate is stored, using the stale cache rows for the skipped groups', async () => {
    const ctx = fakeCtx();
    await ctx.store.put(backoffKey('celestrak:stations'), { failures: 1, notBefore: Date.now() + 3600_000, message: 'fetch failed (UND_ERR_CONNECT_TIMEOUT)' }, 1e9);
    await ctx.store.put('celestrak:starlink', parseOmmJson(fixture('celestrak-starlink.json')), 1, 0); // long expired
    await fast.run!(ctx as never);
    expect(ctx.calls).toEqual([]);
    expect(ctx.upserted.some((e) => e.group === 'starlink')).toBe(true);
    expect(ctx.health.note).toMatch(/stations: waiting until \d\d:\d\dZ.*skipped 10 groups.*starlink \(cache\)/);
  });

  it('a stored 403 gate on one group does not stop the groups after it', async () => {
    const ctx = fakeCtx();
    await ctx.store.put(backoffKey('celestrak:starlink'), { failures: 1, notBefore: Date.now() + 3600_000, message: 'HTTP 403' }, 1e9);
    await fast.run!(ctx as never);
    expect(ctx.calls.map((c) => c.key)).toContain('celestrak:gps-ops');
  });


  it('sends no conditional headers (If-Modified-Since is not CORS-safelisted: it would add a preflight to every download), even with an expired copy', async () => {
    const ctx = fakeCtx();
    await ctx.store.put('celestrak:starlink', parseOmmJson(fixture('celestrak-starlink.json')), 1000, Date.parse('2026-10-24T08:00:00Z'));
    await fast.run!(ctx as never);
    expect(ctx.calls.length).toBeGreaterThan(0);
    for (const c of ctx.calls) expect(c.headers).toBeUndefined();
  });

  it('celestrakUrl is the plain group download', () => {
    expect(celestrakUrl('stations')).toBe('https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=json');
  });

  it('treats a 304 (a cache hit with a fresh timestamp) as success: gate cleared, data kept, no partial note', async () => {
    const ctx = fakeCtx();
    const cached = parseOmmJson(fixture('celestrak-starlink.json'));
    await ctx.store.put('celestrak:starlink', cached, 1000, 0);
    await ctx.store.put(backoffKey('celestrak:starlink'), { failures: 1, notBefore: 1 }, 1e9); // expired gate
    const base = ctx.cachedFetch as (k: string, u: string, t: number, p: (x: string) => unknown) => Promise<unknown>;
    ctx.cachedFetch = (async (key: string, url: string, ttl: number, parse: (x: string) => unknown) =>
      key === 'celestrak:starlink'
        ? { value: cached, fromCache: true, stale: false, fetchedAt: Date.now() }
        : base(key, url, ttl, parse)) as never;
    await fast.run!(ctx as never);
    expect(await readBackoff(ctx.store, 'celestrak:starlink')).toBeUndefined();
    expect(ctx.upserted.some((e) => e.group === 'starlink')).toBe(true);
    expect(ctx.health.note).toBeUndefined();
    expect(ctx.soft).toHaveLength(0);
  });
});

describe('celestrak upstream routing', () => {
  const run = async (upstreams: UpstreamTable) => {
    const prev = setUpstreams(upstreams);
    try {
      const seen: { url: string; headers?: HeadersInit }[] = [];
      const fetchImpl = vi.fn<typeof fetch>(async (input, init) => (seen.push({ url: String(input), headers: init?.headers }), new Response(fixture('celestrak-stations.json'))));
      const store = new MemoryKv();
      const http = new Http(store, { fetch: fetchImpl, limiter: new Limiter(store, { limits: {} }) });
      await http.cachedFetch('celestrak:stations', celestrakUrl('stations'), 1000, parseOmmJson, undefined, { source: 'celestrak', mode: 'poll' });
      return seen;
    } finally {
      setUpstreams(prev);
    }
  };

  it('is called directly by default', async () => {
    const seen = await run(defaultUpstreams());
    expect(seen.map((s) => s.url)).toEqual([celestrakUrl('stations')]);
  });

  it('goes through the relay when the config switch routes it there', async () => {
    const seen = await run(defaultUpstreams({ celestrakViaRelay: true, relayBase: '/relay' }));
    expect(seen.map((s) => s.url)).toEqual([`/relay?url=${encodeURIComponent(celestrakUrl('stations'))}`]);
  });
});
