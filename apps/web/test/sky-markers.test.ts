import { describe, expect, it } from 'vitest';
import type { EntityRecord } from '@eio/core';
import type { V3 } from '../src/lib/camera';
import { groundObserver, type SkyMarker } from '../src/lib/sky-annotations';
import { precessToJ2000, zenithRaDec } from '../src/lib/sky-frame';
import {
  CLICK_DRAG_PX, MARKER_HIT_PX, TURN_MS, easeInOut, fmtDecl, fmtRa, hiddenReason, isDragMove, markerAzEl, markerClick, markerTip, observerFor,
  separationDeg, slerpRaDec,
} from '../src/lib/sky-markers';

const T = Date.UTC(2026, 10, 15, 6, 0, 0);
const marker = (o: Partial<SkyMarker> = {}): SkyMarker => ({ id: 'body-mars', name: 'Mars', kind: 'planet', raDeg: 83.63308, decDeg: 22.0145, distKm: 2.2e8, hidden: false, approx: false, ...o });

describe('clicks on a marker', () => {
  it('a drag is more than 4 px of movement, a click less', () => {
    expect(CLICK_DRAG_PX).toBe(4);
    expect(isDragMove(0, 0)).toBe(false);
    expect(isDragMove(2, 2)).toBe(false);
    expect(isDragMove(3, 3)).toBe(true);
    expect(isDragMove(-5, 0)).toBe(true);
  });

  it('a hit radius of 12 px', () => {
    expect(MARKER_HIT_PX).toBe(12);
  });

  it('empty sky does nothing', () => {
    expect(markerClick(null, 1, null)).toBeNull();
    expect(markerClick(null, 2, 'body-mars')).toBeNull();
  });

  it('a first click turns to the body, a second within the double-click interval on the same body leaves', () => {
    expect(markerClick('body-mars', 1, null)).toEqual({ kind: 'turn', id: 'body-mars' });
    expect(markerClick('body-mars', 2, 'body-mars')).toEqual({ kind: 'leave', id: 'body-mars' });
  });

  it('a second click on another body, or after a click on nothing, is a first click of its own', () => {
    expect(markerClick('body-venus', 2, 'body-mars')).toEqual({ kind: 'turn', id: 'body-venus' });
    expect(markerClick('body-mars', 2, null)).toEqual({ kind: 'turn', id: 'body-mars' });
  });

  it('a slow second click (the browser counts 1 again) turns again', () => {
    expect(markerClick('body-mars', 1, 'body-mars')).toEqual({ kind: 'turn', id: 'body-mars' });
  });
});

describe('observerFor', () => {
  const ground = { id: 'obs-x', provider: { type: 'geodetic', bodyId: 'EARTH', latDeg: 19.8, lonDeg: -155.5, altKm: 4.2 } } as unknown as EntityRecord;
  const space = { id: 'hst', provider: { type: 'sgp4' } } as unknown as EntityRecord;

  it('a ground site is a groundObserver (with its vertical)', () => {
    const o = observerFor(ground, T, () => { throw new Error('not asked'); });
    expect(o).toEqual(groundObserver(19.8, -155.5, 4.2, T));
    expect(o?.up).toBeDefined();
  });

  it('a space telescope is where the scene has it (Earth-inertial), without a vertical', () => {
    const o = observerFor(space, T, (id, t) => (id === 'hst' && t === T ? { r: [7000, 100, -50] as V3 } : null));
    expect(o).toEqual({ r: [7000, 100, -50], bodyId: 'EARTH' });
    expect(o?.up).toBeUndefined();
  });

  it('is null without a position', () => {
    expect(observerFor(space, T, () => null)).toBeNull();
    expect(observerFor(space, T, () => ({ r: [NaN, 0, 0] as V3 }))).toBeNull();
  });
});

describe('coordinates as text', () => {
  it('right ascension in hours, minutes and seconds', () => {
    expect(fmtRa(0)).toBe('00h 00m 00.0s');
    expect(fmtRa(83.63308)).toBe('05h 34m 31.9s');
    expect(fmtRa(180)).toBe('12h 00m 00.0s');
    expect(fmtRa(-15)).toBe('23h 00m 00.0s');
  });

  it('rounds up into the next minute and wraps at 24 h, never 60.0 s', () => {
    expect(fmtRa(14.99999999)).toBe('01h 00m 00.0s');
    expect(fmtRa(359.9999999)).toBe('00h 00m 00.0s');
  });

  it('declination in degrees, minutes and seconds with its sign', () => {
    expect(fmtDecl(22.0145)).toBe("+22° 00' 52\"");
    expect(fmtDecl(-5.5)).toBe("-05° 30' 00\"");
    expect(fmtDecl(0)).toBe("+00° 00' 00\"");
    expect(fmtDecl(-0.0000001)).toBe("+00° 00' 00\""); // rounds to zero: no minus sign
    expect(fmtDecl(-90)).toBe("-90° 00' 00\"");
    expect(fmtDecl(59.99999)).toBe("+60° 00' 00\"");
  });
});

describe('the tooltip', () => {
  it('names the body, gives RA and Dec of J2000 and the distance', () => {
    const lines = markerTip(marker(), null);
    expect(lines[0]).toBe('Mars  ·  planet');
    expect(lines[1]).toBe("RA 05h 34m 31.9s  Dec +22° 00' 52\" (J2000)");
    expect(lines[2]).toBe('Distance 1.47 AU');
    expect(lines).toHaveLength(3);
  });

  it('adds altitude and azimuth for a ground site, the reason when dimmed and the approximate flag', () => {
    const lines = markerTip(marker({ kind: 'dwarf_planet', hidden: true, approx: true }), { azDeg: 123.456, elDeg: -12.34 });
    expect(lines[0]).toBe('Mars  ·  dwarf planet');
    expect(lines).toContain('Alt -12.3°  Az 123.5°');
    expect(lines).toContain('Below the horizon');
    expect(lines[lines.length - 1]).toBe('approximate position');
  });

  it('a hidden body seen from space is behind the Earth', () => {
    expect(hiddenReason({ hidden: true }, false)).toBe('Behind the Earth');
    expect(hiddenReason({ hidden: true }, true)).toBe('Below the horizon');
    expect(hiddenReason({ hidden: false }, true)).toBeNull();
    expect(markerTip(marker({ hidden: true }), null)).toContain('Behind the Earth');
  });
});

describe('altitude and azimuth of a marker', () => {
  it('the zenith of the site is at 90 degrees', () => {
    const lat = 19.8222, lon = -155.4749;
    const z = zenithRaDec(T, lat, lon);
    const j = precessToJ2000(z.raDeg, z.decDeg, T);
    expect(markerAzEl({ raDeg: j.raDeg, decDeg: j.decDeg }, T, lat, lon).elDeg).toBeGreaterThan(89.999);
  });

  it('the celestial pole is near the latitude and due north', () => {
    const a = markerAzEl({ raDeg: 0, decDeg: 90 }, T, 40, 10);
    expect(Math.abs(a.elDeg - 40)).toBeLessThan(0.5); // the pole of J2000 is a fraction of a degree off the pole of date
    expect(Math.min(a.azDeg, 360 - a.azDeg)).toBeLessThan(2);
  });
});

describe('the turn', () => {
  it('is 400 ms', () => {
    expect(TURN_MS).toBe(400);
  });

  it('eases from 0 to 1 and is symmetric', () => {
    expect(easeInOut(-1)).toBe(0);
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(0.5)).toBeCloseTo(0.5, 12);
    expect(easeInOut(1)).toBe(1);
    expect(easeInOut(2)).toBe(1);
    expect(easeInOut(0.25) + easeInOut(0.75)).toBeCloseTo(1, 12);
    expect(easeInOut(0.1)).toBeLessThan(0.1);
  });

  it('follows the great circle between two positions', () => {
    const a = { raDeg: 0, decDeg: 0 }, b = { raDeg: 90, decDeg: 0 };
    expect(slerpRaDec(a, b, 0)).toEqual(a);
    expect(slerpRaDec(a, b, 1)).toEqual(b);
    const m = slerpRaDec(a, b, 0.5);
    expect(m.raDeg).toBeCloseTo(45, 9);
    expect(m.decDeg).toBeCloseTo(0, 9);
    // across the pole: (0, 80) to (180, 80) passes over the pole at dec 90
    expect(slerpRaDec({ raDeg: 0, decDeg: 80 }, { raDeg: 180, decDeg: 80 }, 0.5).decDeg).toBeCloseTo(90, 6);
    // equal parts of the angle
    const c = { raDeg: 90, decDeg: 60 };
    expect(separationDeg(a, slerpRaDec(a, c, 0.3))).toBeCloseTo(0.3 * separationDeg(a, c), 6);
  });

  it('stays put for equal points and fills the given object', () => {
    const p = { raDeg: 12, decDeg: -3 };
    expect(slerpRaDec(p, p, 0.5)).toEqual(p);
    const out = { raDeg: 0, decDeg: 0 };
    expect(slerpRaDec({ raDeg: 0, decDeg: 0 }, { raDeg: 10, decDeg: 0 }, 0.5, out)).toBe(out);
    expect(out.raDeg).toBeCloseTo(5, 9);
  });

  it('separation: 0, 90 and 180 degrees, across RA 0', () => {
    expect(separationDeg({ raDeg: 10, decDeg: 20 }, { raDeg: 10, decDeg: 20 })).toBe(0);
    expect(separationDeg({ raDeg: 0, decDeg: 0 }, { raDeg: 90, decDeg: 0 })).toBeCloseTo(90, 9);
    expect(separationDeg({ raDeg: 0, decDeg: 90 }, { raDeg: 33, decDeg: -90 })).toBeCloseTo(180, 9);
    expect(separationDeg({ raDeg: 359.9, decDeg: 0 }, { raDeg: 0.1, decDeg: 0 })).toBeCloseTo(0.2, 9);
  });
});
