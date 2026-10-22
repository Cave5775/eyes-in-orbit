import { describe, expect, it } from 'vitest';
import { LOD_EXIT, SPRITE_EXIT, modelLod, projectedDiameterPx, ringHiddenFor, type LodInput } from '../src/lib/model-lod';
import { MODELS, modelDef } from '../src/scene/models/registry';

const base: LodInput = {
  distKm: 100, diameterKm: 0.13, lodKm: 45, fovRad: (45 * Math.PI) / 180, viewportPx: 800, spritePx: 10, wasModel: false, wasSpriteHidden: false,
};

describe('projectedDiameterPx', () => {
  it('is size over the view height at that distance', () => {
    // at distance d the viewport spans 2 d tan(fov/2); the ISS (0.13 km) at 1 km fills ~12% of an 800 px view
    expect(projectedDiameterPx(0.13, 1, base.fovRad, 800)).toBeCloseTo((0.13 / (2 * Math.tan(base.fovRad / 2))) * 800, 6);
    expect(projectedDiameterPx(0.13, 1, base.fovRad, 800)).toBeGreaterThan(110);
    expect(projectedDiameterPx(0.13, 2, base.fovRad, 800)).toBeCloseTo(projectedDiameterPx(0.13, 1, base.fovRad, 800) / 2, 6);
  });
  it('is infinite at zero distance', () => {
    expect(projectedDiameterPx(0.13, 0, base.fovRad, 800)).toBe(Infinity);
  });
});

describe('modelLod', () => {
  it('shows only the sprite beyond the LOD distance', () => {
    const r = modelLod({ ...base, distKm: 60 });
    expect(r.model).toBe(false);
    expect(r.hideSprite).toBe(false);
  });

  it('draws the model inside the LOD distance but keeps the sprite while the model is smaller than it', () => {
    const r = modelLod({ ...base, distKm: 40 });
    expect(r.model).toBe(true);
    expect(r.screenPx).toBeLessThan(base.spritePx);
    expect(r.hideSprite).toBe(false);
  });

  it('replaces the sprite once the model is at least as big on screen', () => {
    const r = modelLod({ ...base, distKm: 5 });
    expect(r.model).toBe(true);
    expect(r.screenPx).toBeGreaterThan(base.spritePx);
    expect(r.hideSprite).toBe(true);
  });

  it('has hysteresis on both transitions', () => {
    // model: drawn at 48 km only if it already was (limit 45 * 1.15 = 51.75)
    expect(modelLod({ ...base, distKm: 48, wasModel: false }).model).toBe(false);
    expect(modelLod({ ...base, distKm: 48, wasModel: true }).model).toBe(true);
    expect(modelLod({ ...base, distKm: 55, wasModel: true }).model).toBe(false);
    // sprite: the model must shrink below 80% of the sprite before it returns
    const d = (px: number) => (base.diameterKm / (2 * Math.tan(base.fovRad / 2))) * (base.viewportPx / px);
    expect(modelLod({ ...base, distKm: d(9), wasModel: true, wasSpriteHidden: true }).hideSprite).toBe(true);
    expect(modelLod({ ...base, distKm: d(9), wasModel: true, wasSpriteHidden: false }).hideSprite).toBe(false);
    expect(modelLod({ ...base, distKm: d(base.spritePx * SPRITE_EXIT * 0.95), wasModel: true, wasSpriteHidden: true }).hideSprite).toBe(false);
    expect(LOD_EXIT).toBeGreaterThan(1);
  });

  it('never hides the sprite when the model is not drawn', () => {
    expect(modelLod({ ...base, distKm: 200, wasSpriteHidden: true }).hideSprite).toBe(false);
  });
});

describe('selection ring', () => {
  it('hides once the model is clearly bigger than the ring and returns with hysteresis', () => {
    expect(ringHiddenFor(20, false)).toBe(false);
    expect(ringHiddenFor(100, false)).toBe(true);
    expect(ringHiddenFor(45, false)).toBe(false);
    expect(ringHiddenFor(45, true)).toBe(true);
    expect(ringHiddenFor(30, true)).toBe(false);
  });
});

describe('model registry', () => {
  it('maps render.model keys to definitions with sane true-size data', () => {
    expect(Object.keys(MODELS).sort()).toEqual(['iss', 'rocket-stage', 'satellite']);
    expect(modelDef('iss')?.radiusM).toBeGreaterThan(50); // 109 m x 73 m
    expect(modelDef('nope')).toBeUndefined();
    expect(modelDef(undefined)).toBeUndefined();
    for (const d of Object.values(MODELS)) {
      expect(d.lodKm).toBeGreaterThan(0);
      expect(d.minViewKm).toBeLessThan(d.fitKm);
      expect(d.fitKm).toBeLessThan(d.lodKm);
      expect(d.key).toBe(Object.keys(MODELS).find((k) => MODELS[k] === d));
    }
  });
});
