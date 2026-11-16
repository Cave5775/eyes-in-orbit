import { observatoryAttrs, type EntityRecord } from '@eio/core';
import { describe, expect, it } from 'vitest';
import { categoryOf, matchesType, normaliseType } from '../src/lib/browser-ui';
import { DEFAULT_SPACE_TARGET, FALLBACK_SURVEYS, SURVEYS, coverageNote, fmtLatLon, fmtSkyPercent, observatoryRows, skyTarget, surveyOf, surveyPlan } from '../src/lib/observatories';
import { classify, termFromWord, type Query } from '../src/lib/query';
import { lstRad, precessFromJ2000 } from '../src/lib/sky-frame';
import { mockGroundAndProbes, mockObservatories } from '../src/mock/generators';

const NOW = Date.parse('2026-10-22T12:00:00Z');
const all = (): EntityRecord[] => [...mockGroundAndProbes(NOW), ...mockObservatories(NOW)];

describe('observatory rows', () => {
  const rows = observatoryRows(all());
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

  it('mock mode lists every observatory of the plan: telescopes, DSN complexes and the ten ground sites', () => {
    for (const id of ['dsn-JWST', 'sat-20580', 'dsn-CHDR', 'dsn-TESS', 'dsn-EUCL', 'sat-25989', 'sat-33053', 'dsn-goldstone', 'dsn-madrid', 'dsn-canberra',
      'obs-maunakea', 'obs-paranal', 'obs-rubin', 'obs-haleakala', 'obs-apachepoint', 'obs-vla', 'obs-kittpeak', 'obs-ctio', 'obs-sidingspring', 'obs-palomar']) {
      expect(byId[id], id).toBeDefined();
    }
    expect(rows).toHaveLength(20);
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

  it('every survey of every observatory is offered, and each observatory with imagery has at least one', () => {
    for (const r of rows) {
      expect(r.imagery, r.id).toBe(r.meta.surveys.length > 0);
      for (const id of r.meta.surveys) expect(surveyOf(id), r.id + ' ' + id).toBeDefined();
    }
    const ids = SURVEYS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of SURVEYS) {
      expect(s.skyFraction, s.id).toBeGreaterThan(0);
      expect(s.skyFraction, s.id).toBeLessThanOrEqual(1);
    }
    for (const id of FALLBACK_SURVEYS) expect(surveyOf(id)?.skyFraction, id).toBeGreaterThan(0.5);
  });

  it('an observatory whose survey attribute has only unknown ids has no imagery', () => {
    const rec = { id: 'x', name: 'X', kind: 'ground_station', attrs: observatoryAttrs({ site: 'ground', bands: ['optical'], surveys: ['no/such/survey'] }) } as unknown as EntityRecord;
    expect(observatoryRows([rec])[0].imagery).toBe(false);
  });

  it('each observatory starts with surveys of its own instruments (the default is its first)', () => {
    expect(byId['obs-paranal'].meta.surveys).toEqual(['VOXASTRO/P/VHS/JKs/color', 'CDS/P/VISTA/VIKING/K', 'CDS/P/KiDS/DR5/color-gri']);
    expect(byId['obs-maunakea'].meta.surveys[0]).toBe('VOXASTRO/P/UKIDSS/JHK/color');
    expect(byId['obs-haleakala'].meta.surveys).toEqual(['CDS/P/PanSTARRS/DR1/color-i-r-g']);
    expect(byId['obs-vla'].meta.surveys).toEqual(['CDS/P/NVSS']);
    expect(byId['dsn-CHDR'].meta.surveys).toEqual(['cxc.harvard.edu/P/cda/hips/allsky/rgb']);
    expect(byId['sat-20580'].meta.surveys[0]).toBe('CDS/P/HST/color');
  });

  it('the survey plan is the own list (known ids) then the all-sky fallbacks without repeats', () => {
    const p = surveyPlan(['CDS/P/HST/color', 'nonsense', 'CDS/P/DSS2/color']);
    expect(p.own).toEqual(['CDS/P/HST/color', 'CDS/P/DSS2/color']);
    expect(p.fallbacks).toEqual(FALLBACK_SURVEYS.filter((id) => id !== 'CDS/P/DSS2/color'));
    expect(surveyPlan([]).own).toEqual([]);
    expect(surveyPlan([]).fallbacks).toEqual([...FALLBACK_SURVEYS]);
  });

  it('says how little of the sky a pointed survey covers, and nothing for an all-sky one', () => {
    expect(coverageNote(surveyOf('CDS/P/HST/color'))).toBe('Hubble colour covers 0.18% of the sky; outside its footprint the view is empty (black).');
    expect(coverageNote(surveyOf('CDS/P/JWST/F200W'))).toMatch(/covers 0\.0010% of the sky/);
    expect(coverageNote(surveyOf('CDS/P/DSS2/color'))).toBeNull();
    expect(coverageNote(surveyOf('CDS/P/PanSTARRS/DR1/color-i-r-g'))).toBeNull();
    expect(coverageNote(undefined)).toBeNull();
    expect([0.0018, 0.105, 0.0219, 3.4e-5].map(fmtSkyPercent)).toEqual(['0.18%', '11%', '2.2%', '0.0034%']);
  });
});

describe('sky target', () => {
  const rows = observatoryRows(all());
  const row = (id: string) => rows.find((r) => r.id === id)!;

  it('a ground site is centred on its zenith (J2000 RA/Dec of the of-date zenith: RA = LST, Dec = latitude) and follows the clock', () => {
    const r = row('obs-paranal');
    const t = skyTarget(r, NOW);
    expect(t.tracksZenith).toBe(true);
    // precessed back to the date, the target is the zenith of date
    const ofDate = precessFromJ2000(t.raDeg, t.decDeg, NOW);
    expect(ofDate.decDeg).toBeCloseTo(r.latDeg!, 9);
    expect(ofDate.raDeg).toBeCloseTo((lstRad(NOW, r.lonDeg!) * 180) / Math.PI, 9);
    // and it is the J2000 place: 26.8 years of precession move it by about 0.37 deg (m = 46.1 arcsec/yr in RA at this declination), not zero
    const sep = Math.hypot((t.raDeg - ofDate.raDeg + 540) % 360 - 180, t.decDeg - ofDate.decDeg);
    expect(sep).toBeGreaterThan(0.2);
    expect(sep).toBeLessThan(0.5);
    // 6 h later the zenith RA moved by about 6 sidereal-rate hours (15.041 deg/h)
    const later = skyTarget(r, NOW + 6 * 3_600_000);
    // (not exact in J2000: precession shifts a point by up to n tan(dec) = 9 arcsec/yr x 27 yr differently 90 deg of RA apart, about 0.1 deg)
    expect(Math.abs(((later.raDeg - t.raDeg + 360) % 360) - 6 * 15.041)).toBeLessThan(0.2);
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
  const OBS_IDS = [
    'dsn-CHDR', 'dsn-EUCL', 'dsn-JWST', 'dsn-TESS', 'dsn-canberra', 'dsn-goldstone', 'dsn-madrid', 'obs-apachepoint', 'obs-ctio', 'obs-haleakala', 'obs-kittpeak',
    'obs-maunakea', 'obs-palomar', 'obs-paranal', 'obs-rubin', 'obs-sidingspring', 'obs-vla', 'sat-20580', 'sat-25989', 'sat-33053',
  ];

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
    expect(matchesType({ kind: 'satellite', attrs: observatoryAttrs({ site: 'space', bands: [], surveys: [] }) }, 'observatory')).toBe(true);
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
