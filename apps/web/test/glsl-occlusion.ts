import type { OccluderSet } from '../src/lib/occlusion';

/**
 * The point shader's `bodyHides` (scene/materials.ts) written in float32: every operation rounded with Math.fround, the uniforms
 * (`uOccS`, `uOccE`) and the vertex position rounded the way the GPU receives them. Test helper: it is what the shader computes,
 * to compare with the CPU test (`OccluderSet.hides`, `sphereOccludes`) over the same slots. Keep it line for line with the GLSL.
 */
const f = Math.fround;

export function glslBodyHides(set: Pick<OccluderSet, 'slots' | 'count'>, relX: number, relY: number, relZ: number): boolean {
  const px = f(relX), py = f(relY), pz = f(relZ);
  for (let i = 0; i < set.count; i++) {
    const v = set.slots[i];
    const sx = f(v.x), sy = f(v.y), sz = f(v.z), sw = f(v.r), c2 = f(v.c2), k = f(v.k);
    if (c2 <= 0) continue;
    const dx = px, dy = py, dz = f(pz * k);
    const L = f(Math.sqrt(f(f(f(dx * dx) + f(dy * dy)) + f(dz * dz))));
    if (L <= 0) continue;
    const ux = f(dx / L), uy = f(dy / L), uz = f(dz / L);
    const b = f(f(f(ux * sx) + f(uy * sy)) + f(uz * sz));
    if (b <= 0) continue;
    const cx = f(f(uy * sz) - f(uz * sy)), cy = f(f(uz * sx) - f(ux * sz)), cz = f(f(ux * sy) - f(uy * sx));
    const p = f(Math.sqrt(f(f(f(cx * cx) + f(cy * cy)) + f(cz * cz))));
    if (p >= sw) continue;
    const root = f(Math.sqrt(f(f(sw - p) * f(sw + p))));
    if (f(c2 / f(b + root)) < L) return true;
  }
  return false;
}
