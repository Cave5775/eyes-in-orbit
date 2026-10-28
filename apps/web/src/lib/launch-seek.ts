import { LL2_STATUS, type ClockMode, type Launch } from '@eio/core';
import { fmtTPlus } from './ascent-chart';

/**
 * Pure helpers behind "jump the simulation clock to a launch / to a point of its flight" (state/seek.ts applies them).
 * T-0 is the launch's NET: the server anchors the whole ascent (composite segments, events, telemetry rows) on
 * `Date.parse(launch.net)`, and it moves when the launch does (a hold, a new NET), so read it at the moment of the click.
 */

/** Liftoff (T-0) in sim time, ms; null when the launch has no usable NET. `liftoffMs` is the telemetry series' own, when loaded. */
export function liftoffMsOf(launch: Pick<Launch, 'net'>, liftoffMs?: number | null): number | null {
  const t = liftoffMs ?? Date.parse(launch.net);
  return Number.isFinite(t) ? t : null;
}

/** Sim time of T+`tSec` after liftoff (T- for a negative `tSec`). */
export function eventSimMs(liftoffMs: number, tSec: number): number {
  return liftoffMs + tSec * 1000;
}

/** Inverse of `eventSimMs`: seconds after liftoff at sim time `simMs`. */
export function tPlusSec(liftoffMs: number, simMs: number): number {
  return (simMs - liftoffMs) / 1000;
}

/**
 * Clock rate after a jump inside a flight: the rate stays what it was. Live becomes real time (x1) because a seek leaves
 * live mode; a paused clock stays paused; a scrubbed one keeps its speed and direction (a rewind keeps rewinding).
 */
export function jumpRate(mode: ClockMode, rate: number): number {
  if (mode === 'paused') return 0;
  if (mode === 'live' || !Number.isFinite(rate) || rate === 0) return 1;
  return rate;
}

/**
 * Clock rate after SKIP TO LAUNCH: it should play from T-0, so a paused clock starts at x1 and a rewind turns forward at
 * the same speed; a forward scrub keeps its speed.
 */
export function skipRate(mode: ClockMode, rate: number): number {
  if (mode === 'scrubbed' && Number.isFinite(rate) && rate > 0) return rate;
  if (mode === 'scrubbed' && Number.isFinite(rate) && rate < 0) return -rate;
  return 1;
}

/** NET is only a placeholder while the launch is not yet confirmed (LL2 "To Be Determined" / "To Be Confirmed"). */
export function netUnconfirmed(statusId: number): boolean {
  return statusId === LL2_STATUS.TBD || statusId === LL2_STATUS.TBC;
}

/** Tooltip of a "jump to T+..." control. */
export function jumpTitle(tSec: number): string {
  return `jump to ${fmtTPlus(tSec)}`;
}

/** Tooltip of the SKIP TO LAUNCH button. `net` is the pre-formatted NET text. */
export function skipTitle(statusId: number, net: string): string {
  return `Jump the simulation clock to liftoff (T-0 = NET ${net})${netUnconfirmed(statusId) ? '. The NET is not confirmed yet' : ''}`;
}

/** The launch whose flight the entity's path shows: the launch vehicle itself, or its booster (`parentId` is the vehicle). */
export function launchOfPathEntity(launches: readonly Launch[], id: string, parentId?: string): Launch | undefined {
  return launches.find((l) => l.entityId === id) ?? (parentId ? launches.find((l) => l.entityId === parentId) : undefined);
}

/** Tooltip over a clickable trajectory: T+ against the launch's liftoff, or the UTC time of day without a launch to count from. */
export function pathTipText(tMs: number, liftoffMs: number | null): string {
  if (liftoffMs !== null) return `${fmtTPlus(tPlusSec(liftoffMs, tMs))} · click to jump`;
  return `${new Date(tMs).toISOString().slice(11, 19)} UTC · click to jump`;
}
