import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeCelestrak, parseOmmJson, satKind } from '../src/connectors/celestrak';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const groups = () => ({
  stations: parseOmmJson(fixture('celestrak-stations.json')),
  starlink: parseOmmJson(fixture('celestrak-starlink.json')),
  active: parseOmmJson(fixture('celestrak-active.json')),
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
