/**
 * Hit-testing a drawn trajectory in screen space, split from three.js so it can be tested: given the path's
 * camera-relative points (the buffer the GPU gets), their sample times and a projection * view matrix, find the point of
 * the polyline nearest to the cursor and the time it was sampled at (interpolated between the two samples around it).
 *
 * Used for "click the trajectory to jump to that moment" (scene/SceneController.ts); it only ever sees paths that
 * carry real times (a launch ascent or booster return), never an orbit line.
 */

/** A click or hover within this many CSS px of the drawn line counts as on it. */
export const PATH_HIT_PX = 8;
/** Clip distance (homogeneous w) below which a point is treated as behind the camera. */
const W_EPS = 1e-9;

export interface PathHit {
  /** sample time at the nearest point, ms (interpolated between two samples) */
  tMs: number;
  /** px from the cursor to the line */
  distPx: number;
  /** index of the sample at or before the hit (the hit lies on the segment index .. index+1) */
  index: number;
  /** where the nearest point sits on the screen, CSS px from the viewport's top-left */
  sx: number;
  sy: number;
}

export interface PathPickInput {
  /** camera-relative xyz, 3 per point (the uploaded buffer) */
  rel: ArrayLike<number>;
  /** ascending sample time per point, ms */
  times: ArrayLike<number>;
  /** points in use */
  count: number;
  /** column-major projection * view matrix (three's `.elements`) */
  m: ArrayLike<number>;
  /** viewport size in CSS px */
  w: number;
  h: number;
  /** the cursor in CSS px from the viewport's top-left */
  px: number;
  py: number;
  thresholdPx?: number;
  /** is the camera-relative point hidden behind a body? A hit there is dropped (the line is not visible). */
  occluded?: (x: number, y: number, z: number) => boolean;
}

/**
 * Nearest point of the polyline to the cursor within the threshold, or null. A segment partly behind the camera is
 * clipped at the camera plane, one wholly behind it is skipped. The time is interpolated with the perspective correction
 * (the cursor position along the segment on screen is not linear in 3D, so a foreshortened segment still gives the right
 * time), and the occlusion test runs on the 3D nearest point.
 */
export function nearestOnPath(inp: PathPickInput): PathHit | null {
  const { rel, times, count, m, w, h, px, py } = inp;
  const limit = inp.thresholdPx ?? PATH_HIT_PX;
  if (count < 2) return null;

  // clip coordinates of the current segment's two ends, reused across the loop
  let ax = 0, ay = 0, aw = 0, bx = 0, by = 0, bw = 0;
  const loadB = (i: number) => {
    const x = rel[i * 3], y = rel[i * 3 + 1], z = rel[i * 3 + 2];
    bx = m[0] * x + m[4] * y + m[8] * z + m[12];
    by = m[1] * x + m[5] * y + m[9] * z + m[13];
    bw = m[3] * x + m[7] * y + m[11] * z + m[15];
  };

  let best: PathHit | null = null;
  let bestD = limit;
  loadB(0);
  for (let i = 0; i < count - 1; i++) {
    ax = bx; ay = by; aw = bw; // end of the previous segment is the start of this one
    loadB(i + 1);
    if (aw <= W_EPS && bw <= W_EPS) continue;
    // clip to the camera plane: s0..s1 is the kept part of the segment, as fractions of the whole
    let s0 = 0, s1 = 1;
    let cax = ax, cay = ay, caw = aw, cbx = bx, cby = by, cbw = bw;
    if (aw <= W_EPS) {
      s0 = (W_EPS - aw) / (bw - aw);
      cax = ax + (bx - ax) * s0; cay = ay + (by - ay) * s0; caw = W_EPS;
    } else if (bw <= W_EPS) {
      s1 = (W_EPS - aw) / (bw - aw);
      cbx = ax + (bx - ax) * s1; cby = ay + (by - ay) * s1; cbw = W_EPS;
    }
    const x0 = (cax / caw * 0.5 + 0.5) * w, y0 = (1 - (cay / caw * 0.5 + 0.5)) * h;
    const x1 = (cbx / cbw * 0.5 + 0.5) * w, y1 = (1 - (cby / cbw * 0.5 + 0.5)) * h;
    const dx = x1 - x0, dy = y1 - y0;
    const len2 = dx * dx + dy * dy;
    let u = len2 > 0 ? ((px - x0) * dx + (py - y0) * dy) / len2 : 0;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const qx = x0 + dx * u, qy = y0 + dy * u;
    const d = Math.hypot(qx - px, qy - py);
    if (!(d < bestD)) continue;
    // screen fraction u -> 3D fraction of the clipped segment (perspective-correct), then to the whole segment
    const den = (1 - u) * cbw + u * caw;
    const sc = den > 0 ? (u * caw) / den : u;
    const s = s0 + (s1 - s0) * sc;
    if (inp.occluded) {
      const ox = rel[i * 3] + (rel[i * 3 + 3] - rel[i * 3]) * s;
      const oy = rel[i * 3 + 1] + (rel[i * 3 + 4] - rel[i * 3 + 1]) * s;
      const oz = rel[i * 3 + 2] + (rel[i * 3 + 5] - rel[i * 3 + 2]) * s;
      if (inp.occluded(ox, oy, oz)) continue;
    }
    bestD = d;
    best = { tMs: times[i] + (times[i + 1] - times[i]) * s, distPx: d, index: i, sx: qx, sy: qy };
  }
  return best;
}
