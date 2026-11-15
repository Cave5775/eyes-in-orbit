import { describe, expect, it } from 'vitest';
import {
  BODY_SHAPES, MESH_DROP_FRACTION, MESH_LOAD_PX, baseEllipsoid, ellipsoidScale, meanRadiusOf, meshWanted, shapeOf, type BodyShape,
} from '../src/lib/body-shape';
import { defaultBodies } from '@eio/core';

describe('body shapes', () => {
  it('every entry names a registry body, carries a source, and has sane numbers', () => {
    for (const [id, s] of Object.entries(BODY_SHAPES)) {
      expect(defaultBodies.has(id), id).toBe(true);
      expect(s.source.length, id).toBeGreaterThan(5);
      if (s.kind === 'ellipsoid') {
        const [a, b, c] = s.radiiKm;
        expect(a >= b && b >= c && c > 0, id).toBe(true);
      } else {
        expect(s.url, id).toMatch(/^(\/|https:\/\/)/);
        expect(s.bytes, id).toBeGreaterThan(0);
      }
    }
  });

  it('a body without an entry is a plain sphere', () => {
    expect(shapeOf('MARS')).toBeUndefined();
    expect(baseEllipsoid(undefined)).toBeUndefined();
  });

  const potato: BodyShape = { kind: 'ellipsoid', radiiKm: [13, 11, 9], source: 'test' };
  const mesh: BodyShape = { kind: 'mesh', url: '/models/x.glb', bytes: 1e6, fallback: potato, source: 'test' };

  it('the ellipsoid to draw first is the entry, or the mesh fallback, or none', () => {
    expect(baseEllipsoid(potato)).toBe(potato);
    expect(baseEllipsoid(mesh)).toBe(potato);
    expect(baseEllipsoid({ kind: 'mesh', url: '/m.glb', bytes: 1, source: 's' })).toBeUndefined();
    expect(shapeOf('X', { X: potato })).toBe(potato);
  });

  it('scales the unit sphere per axis, and refuses invalid radii', () => {
    expect(ellipsoidScale([13, 11, 9], 11)).toEqual([13 / 11, 1, 9 / 11]);
    expect(ellipsoidScale([13, 0, 9], 11)).toBeNull();
    expect(ellipsoidScale([13, NaN, 9], 11)).toBeNull();
    expect(ellipsoidScale([13, 11, 9], 0)).toBeNull();
  });

  it('the volume-equivalent radius of a sphere is its radius', () => {
    expect(meanRadiusOf([5, 5, 5])).toBeCloseTo(5, 12);
    expect(meanRadiusOf([8, 1, 1])).toBeCloseTo(2, 12);
  });
});

describe('mesh loading rule', () => {
  it('starts at the load radius, keeps through the hysteresis band, drops below it', () => {
    expect(meshWanted(MESH_LOAD_PX - 1, MESH_LOAD_PX, false)).toBe(false);
    expect(meshWanted(MESH_LOAD_PX, MESH_LOAD_PX, false)).toBe(true);
    // held: stays until under 40% of the load radius
    expect(meshWanted(MESH_LOAD_PX * 0.5, MESH_LOAD_PX, true)).toBe(true);
    expect(meshWanted(MESH_LOAD_PX * MESH_DROP_FRACTION - 0.1, MESH_LOAD_PX, true)).toBe(false);
    // the same size is wanted or not depending on whether it is already held (no flicker at the threshold)
    expect(meshWanted(MESH_LOAD_PX * 0.5, MESH_LOAD_PX, false)).toBe(false);
  });
  it('is never wanted out of view or with no disc', () => {
    expect(meshWanted(500, MESH_LOAD_PX, true, false)).toBe(false);
    expect(meshWanted(0, MESH_LOAD_PX, true)).toBe(false);
    expect(meshWanted(NaN, MESH_LOAD_PX, false)).toBe(false);
  });
});
