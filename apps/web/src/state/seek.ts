import type { Launch } from '@eio/core';
import { eventSimMs, jumpRate, liftoffMsOf, skipRate } from '../lib/launch-seek';
import { clock } from './runtime';

/** Jump the shared simulation clock to `simMs`, keeping its rate (lib/launch-seek.ts `jumpRate`). A non-finite time is ignored. */
export function jumpToSimTime(simMs: number): void {
  if (!Number.isFinite(simMs)) return;
  const s = clock.snapshot();
  clock.seek(simMs, jumpRate(s.mode, s.rate));
}

/** Jump to T+`tSec` of a flight whose liftoff is `liftoffMs`. */
export function jumpToFlightTime(liftoffMs: number, tSec: number): void {
  jumpToSimTime(eventSimMs(liftoffMs, tSec));
}

/**
 * SKIP TO LAUNCH: seek to the launch's liftoff (its NET now, `liftoffMs` when the telemetry series gave one) and play from
 * there. Only the clock moves; a launch without entity data at that time simply shows nothing in the scene. Returns whether it seeked.
 */
export function skipToLaunch(launch: Launch, liftoffMs?: number | null): boolean {
  const t = liftoffMsOf(launch, liftoffMs);
  if (t === null) return false;
  const s = clock.snapshot();
  clock.seek(t, skipRate(s.mode, s.rate));
  return true;
}
