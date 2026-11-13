import { observatoryAttrs, type EntityRecord } from '@eio/core';
import { describe, expect, it } from 'vitest';
import { categoryOf, matchesType, normaliseType } from '../src/lib/browser-ui';
import { DEFAULT_SPACE_TARGET, SURVEYS, fmtLatLon, observatoryRows, skyTarget } from '../src/lib/observatories';
import { classify, termFromWord, type Query } from '../src/lib/query';
import { lstRad } from '../src/lib/sky-frame';
import { mockGroundAndProbes, mockObservatories } from '../src/mock/generators';

const NOW = Date.parse('2026-10-22T12:00:00Z');
const all = (): EntityRecord[] => [...mockGroundAndProbes(NOW), ...mockObservatories(NOW)];

describe('observatory rows', () => {
  const rows = observatoryRows(all());
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

  it('mock mode lists every observatory of the plan: telescopes, DSN complexes and the three ground sites', () => {
    for (const id of ['dsn-JWST', 'sat-20580', 'dsn-CHDR', 'dsn-TESS', 'dsn-goldstone', 'dsn-madrid', 'dsn-canberra', 'obs-maunakea', 'obs-paranal', 'obs-rubin']) {
      expect(byId[id], id).toBeDefined();
    }
    expect(rows).toHaveLength(10);
    expect(byId['dsn-VGR1']).toBeUndefined();
  });

  it('puts space telescopes first, then ground sites, each by name', () => {
    const sites = rows.map((r) => r.meta.site);
    expect(sites.join(',')).toBe([...sites].sort((a, b) => (a === b ? 0 : a === 'space' ? -1 : 1)).join(','));
    const ground = rows.filter((r) => r.meta.site === 'ground').map((r) => r.name);
    expect(ground).toEqual([...ground].sort((a, b) => a.localeCompare(b)));
  });

  it('gives ground sites a place and space telescopes "In space"; DSN dishes have no imagery', () => {
    expect(byId['obs-paranal'].place).toBe('24.63°S 70.40°W');
    expect(byId['sat-20580'].place).toBe('In space');
    expect(byId['dsn-goldstone'].imagery).toBe(false);
    expect(byId['obs-rubin'].imagery).toBe(true);
    expect(fmtLatLon(19.8207, -155.4681)).toBe('19.82°N 155.47°W');
  });

  it('every survey id is a CDS HiPS id and the default of each observatory is offered', () => {
    for (const s of SURVEYS) expect(s.id).toMatch(/^CDS\/P\//);
    for (const r of rows) if (r.meta.survey) expect(SURVEYS.map((s) => s.id)).toContain(r.meta.survey);
  });
});

describe('sky target', () => {
  const rows = observatoryRows(all());
  const row = (id: string) => rows.find((r) => r.id === id)!;

  it('a ground site is centred on its zenith (RA = LST, Dec = latitude) and follows the clock', () => {
    const r = row('obs-paranal');
    const t = skyTarget(r, NOW);
    expect(t.tracksZenith).toBe(true);
    expect(t.decDeg).toBeCloseTo(r.latDeg!, 9);
    expect(t.raDeg).toBeCloseTo((lstRad(NOW, r.lonDeg!) * 180) / Math.PI, 9);
    // 6 h later the zenith RA moved by about 6 sidereal-rate hours (15.041 deg/h)
    const later = skyTarget(r, NOW + 6 * 3_600_000);
    expect((later.raDeg - t.raDeg + 360) % 360).toBeCloseTo(6 * 15.041, 1);
  });

  it('a space telescope starts at the default target and says so', () => {
    const t = skyTarget(row('dsn-JWST'), NOW);
    expect(t).toMatchObject({ raDeg: DEFAULT_SPACE_TARGET.raDeg, decDeg: DEFAULT_SPACE_TARGET.decDeg, tracksZenith: false });
    expect(t.note).toMatch(/not available.*Galactic centre/);
  });
});

describe('observatories in categories and tags', () => {
  const recs = all();
  const rec = (id: string) => recs.find((e) => e.id === id)!;
  const OBS_IDS = ['dsn-CHDR', 'dsn-JWST', 'dsn-TESS', 'dsn-canberra', 'dsn-goldstone', 'dsn-madrid', 'obs-maunakea', 'obs-paranal', 'obs-rubin', 'sat-20580'];

  it('the observatory attribute does not change the category or colour of the entity', () => {
    expect(categoryOf(rec('obs-rubin'))).toBe('ground');
    expect(categoryOf(rec('dsn-goldstone'))).toBe('ground');
    expect(categoryOf(rec('sat-20580'))).toBe('satellites');
    expect(categoryOf(rec('dsn-JWST'))).toBe('probes');
  });

  it('type:observatory (also observatories) matches exactly the entities with the attribute, any kind', () => {
    for (const v of ['observatory', 'observatories', 'Observatories']) {
      expect(normaliseType(v)).toBe('observatory');
      expect(recs.filter((e) => matchesType(e, v)).map((e) => e.id).sort()).toEqual(OBS_IDS);
    }
    expect(matchesType({ kind: 'satellite', attrs: observatoryAttrs({ site: 'space', bands: [], survey: null }) }, 'observatory')).toBe(true);
    expect(matchesType({ kind: 'satellite' }, 'observatory')).toBe(false);
  });

  it('classify (the one query predicate) keeps only observatories for type:observatory and drops them for -type:observatory', () => {
    const only: Query = { terms: [termFromWord('type:observatory', 'only')!] };
    const not: Query = { terms: [termFromWord('-type:observatory', 'only')!] };
    const shown = (q: Query) => recs.filter((e) => classify(e, q) === 'show').map((e) => e.id);
    expect(shown(only).sort()).toEqual(OBS_IDS);
    expect(shown(not)).not.toContain('obs-rubin');
    expect(shown(not)).toContain('dsn-VGR1');
  });
});
