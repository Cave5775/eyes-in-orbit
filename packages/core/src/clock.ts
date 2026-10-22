export type ClockMode = 'live' | 'paused' | 'scrubbed';

export interface ClockSnapshot {
  mode: ClockMode;
  /** sim time, ms since epoch */
  nowMs: number;
  rate: number;
}

/**
 * Single simulation-time source. Everything evaluates `provider.stateAt(clock.now())`.
 * live: wall clock; scrubbed: sim time advances from an anchor at `rate`; paused: frozen.
 */
export class Clock {
  private mode: ClockMode = 'live';
  private rate = 1;
  private anchorSim = 0;
  private anchorWall = 0;
  private listeners = new Set<(s: ClockSnapshot) => void>();

  constructor(private wall: () => number = () => Date.now()) {
    this.anchorSim = wall();
    this.anchorWall = this.anchorSim;
  }

  now(): number {
    switch (this.mode) {
      case 'live':
        return this.wall();
      case 'paused':
        return this.anchorSim;
      case 'scrubbed':
        return this.anchorSim + (this.wall() - this.anchorWall) * this.rate;
    }
  }

  snapshot(): ClockSnapshot {
    return { mode: this.mode, nowMs: this.now(), rate: this.mode === 'live' ? 1 : this.rate };
  }

  goLive(): void {
    this.mode = 'live';
    this.rate = 1;
    this.emit();
  }

  pause(): void {
    this.anchorSim = this.now();
    this.mode = 'paused';
    this.emit();
  }

  /** Jump to an absolute sim time and run at `rate` (rate 0 = frozen there). */
  seek(simMs: number, rate = this.rate): void {
    this.anchorSim = simMs;
    this.anchorWall = this.wall();
    this.rate = rate;
    this.mode = rate === 0 ? 'paused' : 'scrubbed';
    this.emit();
  }

  setRate(rate: number): void {
    this.seek(this.now(), rate);
  }

  subscribe(fn: (s: ClockSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    const s = this.snapshot();
    this.listeners.forEach((l) => l(s));
  }
}
