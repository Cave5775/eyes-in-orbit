import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { launchIdFromCospar } from '@eio/core';
import { DEBRIS_GROUPS, celestrak, normalizeCelestrak, parseOmmJson, satKind } from '../src/connectors/celestrak';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
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

  it('builds sgp4 entities with aliases and render keys', () => {
    const byId = Object.fromEntries(normalizeCelestrak(groups()).map((e) => [e.id, e]));
    expect(byId['sat-25544']).toMatchObject({
      name: 'ISS (ZARYA)', kind: 'station', bodyId: 'EARTH', aliases: { norad: '25544', cospar: '1998-067A', common: 'ISS' },
      provider: { type: 'sgp4' }, render: { colorKey: 'station', footprint: true, orbitLine: true, trailSeconds: 5400 },
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

describe('celestrak connector run', () => {
  const body = (group: string): string => {
    if (group === 'stations') return fixture('celestrak-stations.json');
    if (group === 'starlink') return fixture('celestrak-starlink.json');
    if (group === 'active') return fixture('celestrak-active.json');
    if (group === 'cosmos-2251-debris') return fixture('celestrak-cosmos-2251-debris.json');
    if (group === 'iridium-33-debris') return fixture('celestrak-iridium-33-debris.json');
    throw new Error('HTTP 403');
  };
  function fakeCtx() {
    const calls: { key: string; url: string }[] = [];
    const upserted: { id: string; group?: string }[] = [];
    const soft: { msg: string; retry?: number }[] = [];
    const ctx = {
      calls, upserted, soft,
      health: {} as { note?: string },
      log: () => {},
      hub: { graph: { size: 0 }, upsert: (...r: { id: string; group?: string }[]) => (upserted.push(...r), r.length) },
      softFail: (msg: string, retry?: number) => void soft.push({ msg, retry }),
      cachedFetch: async <T>(key: string, url: string, _ttl: number, parse: (t: string) => T) => {
        calls.push({ key, url });
        const group = key.replace('celestrak:', '');
        return { value: parse(body(group)), fromCache: false, stale: false };
      },
    };
    return ctx;
  }

  it('requests every group once, each under its own cache key', async () => {
    const ctx = fakeCtx();
    await celestrak.run!(ctx as never);
    expect(ctx.calls.map((c) => c.key)).toEqual([
      'celestrak:stations', 'celestrak:starlink', 'celestrak:active',
      'celestrak:cosmos-2251-debris', 'celestrak:iridium-33-debris', 'celestrak:fengyun-1c-debris',
    ]);
    expect(ctx.calls.find((c) => c.key === 'celestrak:iridium-33-debris')!.url).toBe(
      'https://celestrak.org/NORAD/elements/gp.php?GROUP=iridium-33-debris&FORMAT=json',
    );
  });

  it('keeps going and reports a partial failure when a debris group is blocked', async () => {
    const ctx = fakeCtx();
    await celestrak.run!(ctx as never); // fengyun-1c-debris has no fixture and fails
    expect(ctx.upserted.some((e) => e.group === 'cosmos-2251-debris')).toBe(true);
    expect(ctx.upserted.some((e) => e.group === 'fengyun-1c-debris')).toBe(false);
    expect(ctx.health.note).toMatch(/^partial: fengyun-1c-debris: /);
    expect(ctx.soft).toEqual([{ msg: expect.stringContaining('fengyun-1c-debris'), retry: 30 * 60_000 }]);
  });

  it('still throws when every group fails', async () => {
    const ctx = fakeCtx();
    ctx.cachedFetch = (async () => { throw new Error('HTTP 403'); }) as never;
    await expect(celestrak.run!(ctx as never)).rejects.toThrow(/stations: HTTP 403/);
  });
});
