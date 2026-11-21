/**
 * Time and timers the engine uses, injected so the Hub, Scheduler and Limiter run on a controllable clock in tests.
 * `systemClock` reads the globals at call time, so fake timers installed by a test runner are picked up.
 */
export type TimerHandle = ReturnType<typeof setTimeout>;

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(h: TimerHandle | undefined): void;
  setInterval(fn: () => void, ms: number): TimerHandle;
  clearInterval(h: TimerHandle | undefined): void;
  /** a number in [0, 1) for jitter */
  random(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (h) => globalThis.clearInterval(h),
  random: () => Math.random(),
};
