import { BodyRegistry, defaultBodies, type Body } from './bodies';
import { convert, frameId, parseFrame } from './frames';
import type { EntityRecord, FrameId, Sample } from './types';

/**
 * Sphere of influence of `body` relative to its parent, km: the Laplace sphere r = a (m / M)^(2/5) (Laplace 1799; Bate,
 * Mueller and White, "Fundamentals of Astrodynamics", sec. 7.3; Vallado, "Fundamentals of Astrodynamics and Applications"), with `a` the semi-major axis of the body's orbit round its parent and m / M the ratio of the two `gm`
 * values of the registry. A body without an orbit or without a parent (the Sun) has no sphere: undefined.
 */
export function soiKm(body: Body, registry: BodyRegistry = defaultBodies): number | undefined {
  if (!body.parentId || !body.orbit || !(body.gm > 0)) return undefined;
  const parent = registry.has(body.parentId) ? registry.get(body.parentId) : undefined;
  if (!parent || !(parent.gm > 0)) return undefined;
  return body.orbit.a * Math.pow(body.gm / parent.gm, 0.4);
}

/** A sampled track: the frame it is in and `[tMs, x, y, z, ...]` rows (km). */
export interface SampleWindow {
  frame: FrameId;
  samples: readonly Sample[];
}

/** The sample window of a record, when its provider is a sampled track. */
export function sampleWindowOf(rec: { provider?: EntityRecord['provider'] }): SampleWindow | undefined {
  const p = rec.provider;
  return p && p.type === 'sampled' && p.samples.length > 0 ? { frame: p.frame, samples: p.samples } : undefined;
}

/** At most this many samples of a window are tested (evenly spread, first and last included). */
const MAX_TESTED = 24;

const depthOf = (id: string, registry: BodyRegistry): number => registry.lineage(id).length;

/**
 * The body an entity is LISTED under: the deepest body whose sphere of influence contains every sample of its window. When the
 * samples fall in several bodies (an Earth to Mars transfer) it is their lowest common ancestor through `Body.parentId`, so an
 * object that moves between parents is listed under the next higher one (the Sun). A position outside every sphere belongs to
 * the root. Without samples, or when the frame cannot be converted, it is `rec.bodyId`.
 * `bodyId` of the record stays the query centre of its feed; this is only the browsing parent.
 */
export function listParent(
  rec: Pick<EntityRecord, 'bodyId'>,
  window?: SampleWindow,
  registry: BodyRegistry = defaultBodies,
): string {
  if (!window || window.samples.length === 0) return rec.bodyId;
  try {
    if (!registry.has(parseFrame(window.frame).bodyId)) return rec.bodyId;
    const bodies = registry.all().filter((b) => soiKm(b, registry) !== undefined);
    const root = registry.all().find((b) => !b.parentId);
    if (!root) return rec.bodyId;
    const n = window.samples.length;
    const step = Math.max(1, (n - 1) / (MAX_TESTED - 1));
    let common: string[] | undefined; // lineage ids, root first
    for (let k = 0, i = 0; i < n; k++, i = Math.round(k * step)) {
      const s = window.samples[i];
      const t = s[0];
      let best: Body = root;
      let bestDepth = 0;
      for (const b of bodies) {
        const d = depthOf(b.id, registry);
        if (d <= bestDepth) continue;
        const c = convert({ frame: frameId(b.id, 'inertial'), r: [0, 0, 0] }, window.frame, t, registry).r;
        if (Math.hypot(s[1] - c[0], s[2] - c[1], s[3] - c[2]) < soiKm(b, registry)!) {
          best = b;
          bestDepth = d;
        }
      }
      const chain = registry.lineage(best.id).map((b) => b.id).reverse();
      if (!common) common = chain;
      else {
        let m = 0;
        while (m < common.length && m < chain.length && common[m] === chain[m]) m++;
        common = common.slice(0, m);
      }
      if (i >= n - 1) break;
    }
    return common && common.length > 0 ? common[common.length - 1] : rec.bodyId;
  } catch {
    return rec.bodyId;
  }
}
