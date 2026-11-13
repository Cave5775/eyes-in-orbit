import { describe, expect, it } from 'vitest';
import { MIN_ALT_KM, altitudeOf, basisFromUp, ellipsoidUp, surfaceRadius, type V3 } from '../src/lib/camera';
import {
  FP_EYE_KM, FP_FOV_MAX, FP_FOV_MIN, FP_FOV_START, FP_MAX_EL, clampFov, clampFpEl, compassDeg, firstPersonDrag, firstPersonEye, firstPersonLookDir,
  firstPersonReadout, firstPersonStart, focusEndsFirstPerson, selectionEndsFirstPerson, zoomFov,
} from '../src/lib/first-person';

const at = (lat: number, lon: number, alt: number): V3 => {
  const d: V3 = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
  const r = surfaceRadius(d) + alt;
  return [d[0] * r, d[1] * r, d[2] * r];
};
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const DEG = Math.PI / 180;

describe('first-person field of view', () => {
  it('clamps to 1..120 degrees', () => {
    expect(clampFov(0.2)).toBe(FP_FOV_MIN);
    expect(clampFov(500)).toBe(FP_FOV_MAX);
    expect(clampFov(60)).toBe(60);
    expect(clampFov(Number.NaN)).toBe(FP_FOV_START);
  });

  it('zooms in (narrower) for a factor below 1 and out for one above 1, within the limits', () => {
    expect(zoomFov(60, 0.5)).toBeCloseTo(30, 9);
    expect(zoomFov(60, 1.5)).toBeCloseTo(90, 9);
    expect(zoomFov(100, 3)).toBe(FP_FOV_MAX);
    expect(zoomFov(2, 0.1)).toBe(FP_FOV_MIN);
    expect(zoomFov(60, Number.NaN)).toBe(60);
    expect(zoomFov(60, -2)).toBe(60);
  });
});

describe('first-person eye', () => {
  it('is the eye height above a high ground site and does not move a space telescope', () => {
    const site = at(0.3459, -2.7134, 4.205); // Mauna Kea
    const eye = firstPersonEye(site);
    expect(Math.hypot(eye[0] - site[0], eye[1] - site[1], eye[2] - site[2])).toBeCloseTo(FP_EYE_KM, 9);
    expect(dot([eye[0] - site[0], eye[1] - site[1], eye[2] - site[2]], ellipsoidUp(site))).toBeCloseTo(FP_EYE_KM, 9);
    const hst = at(0.5, 1, 540);
    expect(Math.hypot(...hst.map((v, i) => v - firstPersonEye(hst, 0)[i]) as V3)).toBeLessThan(1e-12);
  });

  it('is lifted to the camera altitude floor over a low site, and never below it', () => {
    for (const alt of [0, 0.5, 2.635, 2.99]) {
      const eye = firstPersonEye(at(-0.43, -1.23, alt));
      expect(altitudeOf(eye)).toBeGreaterThanOrEqual(MIN_ALT_KM - 1e-9);
      expect(altitudeOf(eye)).toBeLessThan(MIN_ALT_KM + FP_EYE_KM + 1e-9);
    }
  });

  it('keeps float64 precision: the eye is a few metres from the site, not float32 noise', () => {
    const site = at(0.7, 0.2, 4.205);
    const eye = firstPersonEye(site);
    const d = Math.hypot(eye[0] - site[0], eye[1] - site[1], eye[2] - site[2]);
    expect(Math.abs(d - FP_EYE_KM)).toBeLessThan(1e-9); // float32 at 6,400 km would be about 5e-4 km
  });

  it('returns a degenerate site unchanged', () => {
    expect(firstPersonEye([0, 0, 0])).toEqual([0, 0, 0]);
  });
});

describe('first-person look direction', () => {
  const site = at(0.5, 0.4, 4);
  const basis = basisFromUp(ellipsoidUp(site));

  it('is a unit vector in the local frame: az is a compass bearing, el the elevation', () => {
    const north = firstPersonLookDir(basis, 0, 0);
    const east = firstPersonLookDir(basis, 90 * DEG, 0);
    const zenith = firstPersonLookDir(basis, 0, 90 * DEG);
    expect(dot(north, basis.n)).toBeCloseTo(1, 9);
    expect(dot(east, basis.e)).toBeCloseTo(1, 9);
    expect(dot(zenith, basis.u)).toBeCloseTo(1, 9);
    const d = firstPersonLookDir(basis, 120 * DEG, 15 * DEG);
    expect(Math.hypot(...d)).toBeCloseTo(1, 9);
    expect(dot(d, basis.u)).toBeCloseTo(Math.sin(15 * DEG), 9);
    expect(dot(d, basis.e)).toBeCloseTo(Math.cos(15 * DEG) * Math.sin(120 * DEG), 9);
    expect(dot(d, basis.n)).toBeCloseTo(Math.cos(15 * DEG) * Math.cos(120 * DEG), 9);
  });

  it('a space telescope looking down sees the Earth: negative elevation points away from the zenith', () => {
    const d = firstPersonLookDir(basis, 0, -60 * DEG);
    expect(dot(d, basis.u)).toBeLessThan(-0.8);
  });
});

describe('first-person drag', () => {
  it('grabs the sky: dragging right looks left, dragging down looks up, at the field of view per pixel', () => {
    const r = firstPersonDrag(1, 0.2, 10, 0, 60, 600);
    expect(r.az).toBeCloseTo(1 - 10 * (60 * DEG) / 600, 12);
    expect(r.el).toBe(0.2);
    const u = firstPersonDrag(1, 0.2, 0, 10, 60, 600);
    expect(u.el).toBeCloseTo(0.2 + 10 * (60 * DEG) / 600, 12);
    expect(u.az).toBe(1);
  });

  it('turns more slowly through a narrow field of view', () => {
    const wide = firstPersonDrag(0, 0, 100, 0, 90, 600).az;
    const narrow = firstPersonDrag(0, 0, 100, 0, 9, 600).az;
    expect(Math.abs(narrow)).toBeCloseTo(Math.abs(wide) / 10, 12);
  });

  it('stops short of straight up and straight down', () => {
    expect(firstPersonDrag(0, 1.49, 0, 5000, 60, 600).el).toBe(FP_MAX_EL);
    expect(firstPersonDrag(0, -1.49, 0, -5000, 60, 600).el).toBe(-FP_MAX_EL);
    expect(clampFpEl(3)).toBe(FP_MAX_EL);
  });

  it('survives a zero-height viewport', () => {
    const r = firstPersonDrag(0, 0, 10, 10, 60, 0);
    expect(Number.isFinite(r.az) && Number.isFinite(r.el)).toBe(true);
  });
});

describe('first-person readout and start', () => {
  it('names the observatory, the bearing, the elevation and the field of view', () => {
    expect(firstPersonReadout('Mauna Kea Observatories', 120 * DEG, 15 * DEG, 60)).toBe('Looking from Mauna Kea Observatories, az 120 deg el 15 deg, FOV 60 deg');
  });

  it('wraps the bearing into 0..359', () => {
    expect(compassDeg(-90 * DEG)).toBeCloseTo(270, 9);
    expect(compassDeg(450 * DEG)).toBeCloseTo(90, 9);
    expect(firstPersonReadout('X', 359.7 * DEG, 0, 60)).toContain('az 0 deg');
    expect(firstPersonReadout('X', -1 * DEG, -20 * DEG, 12.4)).toBe('Looking from X, az 359 deg el -20 deg, FOV 12 deg');
  });

  it('starts a ground site a little above the horizon and a space telescope level, both at 60 degrees', () => {
    const g = firstPersonStart(4.2), s = firstPersonStart(540);
    expect(g.el).toBeGreaterThan(0.2);
    expect(s.el).toBe(0);
    expect(g.fov).toBe(60);
    expect(s.fov).toBe(60);
  });
});

describe('what ends the first-person view', () => {
  it('a request for the same observatory stays; another object, a ground point or the home view leaves', () => {
    expect(focusEndsFirstPerson('obs-maunakea', { id: 'obs-maunakea' })).toBe(false);
    expect(focusEndsFirstPerson('obs-maunakea', { id: 'obs-paranal' })).toBe(true);
    expect(focusEndsFirstPerson('obs-maunakea', {})).toBe(true);
  });

  it('a selection of anything else, or none, leaves', () => {
    expect(selectionEndsFirstPerson('obs-maunakea', 'obs-maunakea')).toBe(false);
    expect(selectionEndsFirstPerson('obs-maunakea', 'iss')).toBe(true);
    expect(selectionEndsFirstPerson('obs-maunakea', null)).toBe(true);
  });
});
