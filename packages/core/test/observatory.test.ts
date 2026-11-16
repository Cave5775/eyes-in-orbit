import { describe, expect, it } from 'vitest';
import { FERMI_NORAD, GROUND_OBSERVATORIES, HUBBLE_NORAD, SPACE_OBSERVATORY_META, XMM_NORAD, observatoryAttrs, observatoryOf } from '../src/observatory';

describe('observatory attributes', () => {
  it('round-trips through the plain-string attrs, a survey list included', () => {
    const meta = { site: 'space', bands: ['optical', 'infrared'], surveys: ['CDS/P/2MASS/color', 'CDS/P/DSS2/color'] } as const;
    const attrs = observatoryAttrs({ ...meta, bands: [...meta.bands], surveys: [...meta.surveys] });
    expect(attrs.observatorySurvey).toBe('CDS/P/2MASS/color,CDS/P/DSS2/color');
    expect(observatoryOf({ attrs })).toEqual({ ...meta, bands: [...meta.bands], surveys: [...meta.surveys] });
    const dish = { site: 'ground', bands: ['radio'], surveys: [] } as const;
    expect(observatoryOf({ attrs: observatoryAttrs({ ...dish, bands: [...dish.bands], surveys: [] }) })).toEqual({ ...dish, bands: ['radio'], surveys: [] });
  });

  it('reads the older single-survey attribute as a list of one (and none as an empty list)', () => {
    expect(observatoryOf({ attrs: { observatory: 'ground', observatoryBands: 'optical', observatorySurvey: 'CDS/P/DSS2/color' } })?.surveys).toEqual(['CDS/P/DSS2/color']);
    expect(observatoryOf({ attrs: { observatory: 'ground', observatoryBands: 'radio', observatorySurvey: '' } })?.surveys).toEqual([]);
    expect(observatoryOf({ attrs: { observatory: 'ground' } })?.surveys).toEqual([]);
  });

  it('is null for anything that is not an observatory', () => {
    expect(observatoryOf({})).toBeNull();
    expect(observatoryOf({ attrs: { rangeKm: 5 } })).toBeNull();
    expect(observatoryOf({ attrs: { observatory: 'orbital' } })).toBeNull();
    expect(observatoryOf({ attrs: { observatory: true } })).toBeNull();
  });

  it('lists the ground sites with unique ids, plausible coordinates, a source and at least one survey', () => {
    const ids = GROUND_OBSERVATORIES.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(['obs-maunakea', 'obs-paranal', 'obs-rubin', 'obs-haleakala', 'obs-apachepoint', 'obs-vla', 'obs-kittpeak', 'obs-ctio', 'obs-sidingspring', 'obs-palomar']));
    for (const o of GROUND_OBSERVATORIES) {
      expect(Math.abs(o.latDeg), o.id).toBeLessThan(35);
      expect(Math.abs(o.lonDeg), o.id).toBeLessThanOrEqual(180);
      expect(o.altKm, o.id).toBeGreaterThan(1);
      expect(o.altKm, o.id).toBeLessThan(5);
      expect(o.source).toMatch(/^https:/);
      expect(o.meta.surveys.length, o.id).toBeGreaterThan(0);
      expect(new Set(o.meta.surveys).size).toBe(o.meta.surveys.length);
    }
    expect(HUBBLE_NORAD).toBe(20580);
    expect([XMM_NORAD, FERMI_NORAD]).toEqual([25989, 33053]);
  });

  it('gives every space observatory a survey list', () => {
    for (const [k, m] of Object.entries(SPACE_OBSERVATORY_META)) {
      expect(m.site, k).toBe('space');
      expect(m.surveys.length, k).toBeGreaterThan(0);
    }
  });
});
