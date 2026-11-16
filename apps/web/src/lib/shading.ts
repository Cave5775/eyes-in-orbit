/**
 * Sunlight shading of 3D objects (View menu > Sunlight shading). On: the Sun, earthshine and a dim ambient light, so the half
 * facing away is dark (and a satellite in the Earth's shadow dims). Off: an even ambient light only, so a model's whole
 * texture reads from every side; the body shaders get the same switch as the uniform `SHADING` (scene/materials.ts).
 */
export const SUN_I = 3.3;
export const AMBIENT_I = 1.2;
export const EARTHSHINE_I = 1.1;
/** three's lights give albedo * I * cos / pi, so an ambient of PI shows the albedo as is; a little less keeps white from clipping. */
export const FLAT_AMBIENT_I = 0.9 * Math.PI;

export interface LightRig { sun: number; earth: number; ambient: number }

/** Light intensities for a model: `sunlit` = the fraction of the Sun's disc in view (0 in umbra), `day` = earthshine weight. */
export function lightRig(shaded: boolean, sunlit: number, day: number): LightRig {
  if (!shaded) return { sun: 0, earth: 0, ambient: FLAT_AMBIENT_I };
  return { sun: SUN_I * sunlit, earth: EARTHSHINE_I * day, ambient: AMBIENT_I };
}
