import { describe, expect, it } from 'vitest';
import { GROUND_OBSERVATORIES, HUBBLE_NORAD, observatoryAttrs, observatoryOf } from '../src/observatory';

describe('observatory attributes', () => {
  it('round-trips through the plain-string attrs', () => {
    const meta = { site: 'space', bands: ['optical', 'infrared'], survey: 'CDS/P/2MASS/color' } as const;
    expect(observatoryOf({ attrs: observatoryAttrs({ ...meta, bands: [...meta.bands] }) })).toEqual(meta);
    const dish = { site: 'ground', bands: ['radio'], survey: null } as const;
    expect(observatoryOf({ attrs: observatoryAttrs({ ...dish, bands: [...dish.bands] }) })).toEqual(dish);
  });

  it('is null for anything that is not an observatory', () => {
    expect(observatoryOf({})).toBeNull();
    expect(observatoryOf({ attrs: { rangeKm: 5 } })).toBeNull();
    expect(observatoryOf({ attrs: { observatory: 'orbital' } })).toBeNull();
    expect(observatoryOf({ attrs: { observatory: true } })).toBeNull();
  });

  it('lists the three ground sites with plausible coordinates', () => {
    expect(GROUND_OBSERVATORIES.map((o) => o.id)).toEqual(['obs-maunakea', 'obs-paranal', 'obs-rubin']);
    for (const o of GROUND_OBSERVATORIES) {
      expect(Math.abs(o.latDeg)).toBeLessThan(35);
      expect(o.altKm).toBeGreaterThan(2);
      expect(o.source).toMatch(/^https:/);
    }
    expect(HUBBLE_NORAD).toBe(20580);
  });
});
