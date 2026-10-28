/**
 * Screen-space object labels, split from three.js so the rules can be tested: which labels are shown, which are dropped
 * and how they fade. The scene projects its candidates (bodies, the selection, featured objects and what the search matches) to CSS px
 * and hands them to a `LabelPlanner`; the DOM layer (scene/LabelLayer.ts) draws what comes back.
 *
 * Rules:
 * - a body label fades with the body's apparent size: full while it is a small disc, gone once it fills the view (so
 *   labels appear when zoomed out and the default Earth view stays clean);
 * - priority: the selection, then the hovered object, then bodies, then entities marked `render.label`, then the
 *   satellites a search (text or tags) lets through; inside a class the one nearest the screen centre wins. A label that was shown last frame gets a small
 *   bonus so a declutter decision does not flicker as the camera moves;
 * - at most `MAX_LABELS` are shown, and a label whose box would overlap one already accepted is dropped (the selection
 *   and the hovered object are never dropped for overlap);
 * - the planner owns pooled storage: nothing is allocated per frame once it has grown to its working size.
 */

/** Most labels on screen at once (selection and hover included). */
export const MAX_LABELS = 48;
/** Label box height, px (matches `.scene-label` in styles.css). */
export const LABEL_H = 16;
/** Average glyph advance of the label font (10.5 px mono, 0.06em tracking), px, and horizontal padding + border, px. */
export const LABEL_CHAR_W = 7;
export const LABEL_PAD_X = 10;
/** Gap kept between two label boxes, px. */
export const LABEL_GAP = 2;
/** A body whose apparent radius is below this shows its label fully, px. */
export const BODY_FADE_FULL_PX = 50;
/** ... and one at or above this shows none (it fills the view and names itself), px. */
export const BODY_FADE_NONE_PX = 220;
/** Candidates a scan keeps per point set when a search is active (the planner then picks at most `MAX_LABELS`). */
export const LABEL_SCAN_KEEP = 96;
/** A label whose opacity is below this is not drawn. */
const MIN_OPACITY = 0.03;

export type LabelClass = 'selected' | 'hover' | 'body' | 'featured' | 'satellite';

/** Lower = more important. */
const RANK: Record<LabelClass, number> = { selected: 0, hover: 1, body: 2, featured: 3, satellite: 4 };

/** Px per rank step in the sort key: far above any screen distance. */
const RANK_STEP = 1e6;
/** A label shown last frame ranks as if this much nearer the centre. */
const STICKY = 0.6;

/** Apparent radius of a sphere in px: `distKm` to its centre, `fovDeg` vertical field of view, `viewportH` px. Huge when inside it. */
export function apparentRadiusPx(distKm: number, radiusKm: number, fovDeg: number, viewportH: number): number {
  if (!(radiusKm > 0)) return 0;
  if (distKm <= radiusKm) return Infinity;
  const tanHalf = Math.tan((fovDeg * Math.PI) / 360);
  return (Math.tan(Math.asin(radiusKm / distKm)) / tanHalf) * (viewportH / 2);
}

/** Opacity of a body label from the body's apparent radius (px): 1 up to `BODY_FADE_FULL_PX`, linear to 0 at `BODY_FADE_NONE_PX`. */
export function bodyLabelOpacity(radiusPx: number): number {
  if (!(radiusPx < BODY_FADE_NONE_PX)) return 0;
  if (radiusPx <= BODY_FADE_FULL_PX) return 1;
  return (BODY_FADE_NONE_PX - radiusPx) / (BODY_FADE_NONE_PX - BODY_FADE_FULL_PX);
}

/** Longest label text, characters: "FALCON 9 BLOCK 5 | STARLINK GROUP 10-31 (BOOSTER)" would span a third of the view. */
export const MAX_LABEL_CHARS = 28;

/** The name as shown: cut to `MAX_LABEL_CHARS` with an ellipsis. */
export const labelText = (name: string): string => (name.length > MAX_LABEL_CHARS ? `${name.slice(0, MAX_LABEL_CHARS - 1).trimEnd()}…` : name);

/** Estimated box width of a label, px. */
export const labelWidth = (text: string): number => text.length * LABEL_CHAR_W + LABEL_PAD_X;

/**
 * Keep the `k` smallest of `keys[0..n)`: writes their indices to `out` (length >= k) and returns how many (min(n, k)).
 * Linear time, no sort: a histogram over `[0, maxKey]` finds the bucket the k-th falls in, everything below it is taken and
 * the rest of the quota is filled from that bucket in index order (exact count, order within a bucket is not exact).
 * `counts` is scratch of length `BUCKETS`.
 */
export const BUCKETS = 128;
export function selectNearest(keys: ArrayLike<number>, n: number, k: number, maxKey: number, out: Int32Array, counts: Int32Array): number {
  if (n <= k) {
    for (let i = 0; i < n; i++) out[i] = i;
    return n;
  }
  counts.fill(0);
  const scale = (BUCKETS - 1) / maxKey;
  const bucket = (v: number) => (v <= 0 ? 0 : v >= maxKey ? BUCKETS - 1 : Math.floor(v * scale));
  for (let i = 0; i < n; i++) counts[bucket(keys[i])]++;
  let acc = 0, edge = 0;
  while (edge < BUCKETS && acc + counts[edge] < k) acc += counts[edge++];
  // buckets [0, edge) are taken whole, bucket `edge` tops up
  let m = 0, room = k - acc;
  for (let i = 0; i < n && m < k; i++) {
    const b = bucket(keys[i]);
    if (b < edge) out[m++] = i;
  }
  for (let i = 0; i < n && room > 0; i++) {
    if (bucket(keys[i]) === edge) {
      out[m++] = i;
      room--;
    }
  }
  return m;
}

/** One label the scene wants shown, in CSS px inside the scene container. */
export interface LabelCandidate {
  id: string;
  text: string;
  cls: LabelClass;
  /** the object's screen position */
  x: number;
  y: number;
  /** the box starts this far right of `x` (clear of the marker), px */
  dx: number;
  /** 0..1 from the caller (body fade) */
  opacity: number;
}

/** A label the planner accepted: `x`/`y` are the top-left of its box. */
export interface PlannedLabel {
  id: string;
  text: string;
  cls: LabelClass;
  x: number;
  y: number;
  opacity: number;
}

export class LabelPlanner {
  private cands: LabelCandidate[] = [];
  private n = 0;
  private keys = new Float64Array(64);
  private order: number[] = [];
  private boxes = new Float64Array(4 * (MAX_LABELS + 8));
  private shown = new Set<string>();
  private prev = new Set<string>();
  /** the accepted labels of the last `plan`, first `count` entries valid (pooled objects, reused by the next call) */
  readonly out: PlannedLabel[] = [];
  count = 0;
  private readonly byKey = (a: number, b: number): number => this.keys[a] - this.keys[b] || a - b;

  constructor(private readonly max: number = MAX_LABELS) {}

  /** Start a frame's candidate list. */
  begin(): void {
    this.n = 0;
  }

  add(id: string, text: string, cls: LabelClass, x: number, y: number, dx: number, opacity = 1): void {
    if (!(opacity >= MIN_OPACITY)) return;
    let c = this.cands[this.n];
    if (!c) c = this.cands[this.n] = { id: '', text: '', cls: 'body', x: 0, y: 0, dx: 0, opacity: 1 };
    c.id = id;
    c.text = text;
    c.cls = cls;
    c.x = x;
    c.y = y;
    c.dx = dx;
    c.opacity = opacity;
    this.n++;
  }

  /**
   * Choose the labels to show in a `vw` x `vh` viewport. Fills `out[0..count)` (highest priority first) and returns the
   * count. A candidate whose box lies fully outside the viewport is dropped.
   */
  plan(vw: number, vh: number): number {
    const n = this.n;
    if (this.keys.length < n) this.keys = new Float64Array(Math.max(n, this.keys.length * 2));
    const prev = this.shown;
    this.shown = this.prev;
    this.prev = prev;
    this.shown.clear();

    const cx = vw / 2, cy = vh / 2;
    this.order.length = 0;
    for (let i = 0; i < n; i++) {
      const c = this.cands[i];
      const left = c.x + c.dx, top = c.y - LABEL_H / 2;
      if (left > vw || left + labelWidth(c.text) < 0 || top > vh || top + LABEL_H < 0) continue;
      const d = Math.hypot(c.x - cx, c.y - cy) * (prev.has(c.id) ? STICKY : 1);
      this.keys[i] = RANK[c.cls] * RANK_STEP + d;
      this.order.push(i);
    }
    this.order.sort(this.byKey);

    let count = 0;
    for (let k = 0; k < this.order.length; k++) {
      const c = this.cands[this.order[k]];
      const must = c.cls === 'selected' || c.cls === 'hover';
      if (count >= this.max && !must) break;
      const w = labelWidth(c.text);
      const left = c.x + c.dx, top = c.y - LABEL_H / 2;
      if (!must && this.overlaps(count, left, top, w)) continue;
      if (count >= this.boxes.length / 4) this.growBoxes();
      const b = count * 4;
      this.boxes[b] = left;
      this.boxes[b + 1] = top;
      this.boxes[b + 2] = left + w;
      this.boxes[b + 3] = top + LABEL_H;
      let o = this.out[count];
      if (!o) o = this.out[count] = { id: '', text: '', cls: 'body', x: 0, y: 0, opacity: 1 };
      o.id = c.id;
      o.text = c.text;
      o.cls = c.cls;
      o.x = left;
      o.y = top;
      o.opacity = c.opacity;
      this.shown.add(c.id);
      count++;
    }
    this.count = count;
    return count;
  }

  private overlaps(count: number, left: number, top: number, w: number): boolean {
    const right = left + w + LABEL_GAP, bottom = top + LABEL_H + LABEL_GAP;
    const b = this.boxes;
    for (let i = 0; i < count; i++) {
      const o = i * 4;
      if (left < b[o + 2] + LABEL_GAP && right > b[o] && top < b[o + 3] + LABEL_GAP && bottom > b[o + 1]) return true;
    }
    return false;
  }

  private growBoxes(): void {
    const next = new Float64Array(this.boxes.length * 2);
    next.set(this.boxes);
    this.boxes = next;
  }
}
