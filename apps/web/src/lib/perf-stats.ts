/** Pure stats for the perf readout: a fixed-size rolling window with percentiles, and a per-second event rate. */

/** Percentile of an ascending-sorted array by linear interpolation; NaN when empty. `p` in 0..100. */
export function percentileSorted(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

/** The last `size` samples; push is O(1), statistics sort a copy (call them a few times a second, not per frame). */
export class RollingWindow {
  private buf: Float64Array;
  private next = 0;
  private len = 0;

  constructor(readonly size: number) {
    this.buf = new Float64Array(Math.max(1, size));
  }

  push(v: number): void {
    this.buf[this.next] = v;
    this.next = (this.next + 1) % this.buf.length;
    if (this.len < this.buf.length) this.len++;
  }

  get count(): number {
    return this.len;
  }

  clear(): void {
    this.next = 0;
    this.len = 0;
  }

  private sorted(): Float64Array {
    return this.buf.slice(0, this.len).sort();
  }

  percentile(p: number): number {
    return percentileSorted(this.sorted(), p);
  }

  mean(): number {
    if (!this.len) return NaN;
    let s = 0;
    for (let i = 0; i < this.len; i++) s += this.buf[i];
    return s / this.len;
  }

  max(): number {
    if (!this.len) return NaN;
    let m = -Infinity;
    for (let i = 0; i < this.len; i++) if (this.buf[i] > m) m = this.buf[i];
    return m;
  }

  /** p50, p95, mean and max from one sort */
  summary(): { n: number; p50: number; p95: number; mean: number; max: number } {
    const s = this.sorted();
    return { n: s.length, p50: percentileSorted(s, 50), p95: percentileSorted(s, 95), mean: this.mean(), max: this.max() };
  }
}

/** Events per second over a sliding span of `spanMs` (timestamps in ms, any monotonic clock). */
export class RateCounter {
  private stamps: number[] = [];

  constructor(readonly spanMs = 1000) {}

  hit(now: number): void {
    this.stamps.push(now);
    this.trim(now);
  }

  perSecond(now: number): number {
    this.trim(now);
    return (this.stamps.length * 1000) / this.spanMs;
  }

  private trim(now: number): void {
    let i = 0;
    while (i < this.stamps.length && this.stamps[i] <= now - this.spanMs) i++;
    if (i) this.stamps.splice(0, i);
  }
}
