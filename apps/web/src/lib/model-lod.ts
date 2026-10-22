/**
 * Level of detail for 3D models (pure). An entity with a model is a point sprite from afar. Once the camera is within
 * the model's `lodKm` the model is drawn too; the sprite is dropped only when the model has grown past the sprite's
 * own size on screen, so the object never shrinks while it swaps. Both transitions have hysteresis so the choice does
 * not flicker while zooming through a threshold.
 */

/** Model is dropped again only beyond `lodKm * LOD_EXIT`. */
export const LOD_EXIT = 1.15;
/** Sprite comes back when the model is smaller than `spritePx * SPRITE_EXIT`. */
export const SPRITE_EXIT = 0.8;

export interface LodInput {
  /** camera to model centre, km */
  distKm: number;
  /** model bounding diameter, km */
  diameterKm: number;
  /** distance at which the model starts being drawn, km */
  lodKm: number;
  /** vertical field of view, radians, and the viewport height in CSS pixels */
  fovRad: number;
  viewportPx: number;
  /** size of the entity's point sprite, CSS pixels */
  spritePx: number;
  wasModel: boolean;
  wasSpriteHidden: boolean;
}

export interface LodResult {
  /** draw the model */
  model: boolean;
  /** the sprite is replaced by the model (hide it) */
  hideSprite: boolean;
  /** model's projected diameter, CSS pixels */
  screenPx: number;
}

/** On-screen diameter in CSS pixels of a sphere of `diameterKm` at `distKm` (perspective, vertical fov). */
export function projectedDiameterPx(diameterKm: number, distKm: number, fovRad: number, viewportPx: number): number {
  if (!(distKm > 0)) return Infinity;
  return (diameterKm / (2 * distKm * Math.tan(fovRad / 2))) * viewportPx;
}

export function modelLod(i: LodInput): LodResult {
  const model = i.distKm < (i.wasModel ? i.lodKm * LOD_EXIT : i.lodKm);
  const screenPx = projectedDiameterPx(i.diameterKm, i.distKm, i.fovRad, i.viewportPx);
  const hideSprite = model && screenPx >= i.spritePx * (i.wasSpriteHidden ? SPRITE_EXIT : 1);
  return { model, hideSprite, screenPx };
}

/** The selection ring (26 px) stays while the model is smaller than it; a big model is its own selection cue. */
export const RING_PX = 26;
export const ringHiddenFor = (screenPx: number, wasHidden: boolean): boolean => screenPx > RING_PX * (wasHidden ? 1.5 : 2.2);
