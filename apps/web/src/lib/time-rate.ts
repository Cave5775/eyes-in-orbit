import type { ClockMode } from '@eio/core';

/** Selectable speed magnitudes, sim seconds per wall second. */
export const SPEEDS = [1, 10, 60, 600];

export interface RatePref {
  speed: number;
  reverse: boolean;
}

/** Clock rate for a speed magnitude and direction (negative = rewind). */
export function signedRate(speed: number, reverse: boolean): number {
  return reverse ? -speed : speed;
}

/** Magnitude and direction of a clock rate; 0 yields `fallback` (a paused clock keeps no rate of its own). */
export function splitRate(rate: number, fallback: RatePref = { speed: 1, reverse: false }): RatePref {
  return rate === 0 || !Number.isFinite(rate) ? fallback : { speed: Math.abs(rate), reverse: rate < 0 };
}

/** Mode chip text: LIVE, PAUSED, or the direction symbol and speed (`◀ x60` while rewinding). */
export function fmtRateLabel(mode: ClockMode, rate: number): string {
  if (mode === 'live') return 'LIVE';
  if (mode === 'paused') return 'PAUSED';
  return `${rate < 0 ? '◀' : '▶'} ×${Math.abs(rate)}`;
}
