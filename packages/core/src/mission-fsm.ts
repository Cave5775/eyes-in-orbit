import type { MissionPhase } from './types';

/** Launch Library 2 launch_status ids. */
export const LL2_STATUS = {
  GO: 1,
  TBD: 2,
  SUCCESS: 3,
  FAILURE: 4,
  HOLD: 5,
  IN_FLIGHT: 6,
  PARTIAL_FAILURE: 7,
  TBC: 8,
} as const;

export interface MissionInput {
  /** LL2 status id */
  statusId: number;
  /** scheduled launch time (NET), ms */
  netMs: number;
  nowMs: number;
  /** how long after liftoff powered ascent lasts, default ~9 min */
  ascentSec?: number;
  /** how long after ascent the insertion phase lasts, default ~10 min */
  insertionSec?: number;
  /** T-minus window in which the phase is COUNTDOWN, default 30 min */
  countdownSec?: number;
}

export interface MissionState {
  phase: MissionPhase;
  hold: boolean;
  /** netMs - nowMs; negative after liftoff */
  tMinusMs: number;
  /** true when the phase is inferred from time rather than reported by the provider */
  inferred: boolean;
}

/**
 * SCHEDULED -> COUNTDOWN -> ACTIVE_ASCENT -> ORBIT_INSERTION -> ON_ORBIT
 * Terminal status codes from LL2 win; otherwise time relative to NET drives the phase.
 */
export function deriveMissionState(i: MissionInput): MissionState {
  const ascent = (i.ascentSec ?? 540) * 1000;
  const insertion = (i.insertionSec ?? 600) * 1000;
  const countdown = (i.countdownSec ?? 1800) * 1000;
  const tMinusMs = i.netMs - i.nowMs;
  const sinceLiftoff = -tMinusMs;
  const hold = i.statusId === LL2_STATUS.HOLD;

  switch (i.statusId) {
    case LL2_STATUS.FAILURE:
      return { phase: 'FAILED', hold: false, tMinusMs, inferred: false };
    case LL2_STATUS.SUCCESS:
    case LL2_STATUS.PARTIAL_FAILURE:
      return { phase: 'ON_ORBIT', hold: false, tMinusMs, inferred: false };
    case LL2_STATUS.IN_FLIGHT:
      return { phase: inFlightPhase(sinceLiftoff, ascent, insertion), hold: false, tMinusMs, inferred: true };
  }

  // Pre-launch statuses (Go / TBD / TBC / Hold). A launch that has passed NET but is not
  // yet marked In Flight is treated as liftoff having just occurred only for a short grace period.
  if (sinceLiftoff > 0 && !hold && i.statusId === LL2_STATUS.GO && sinceLiftoff < ascent + insertion) {
    return { phase: inFlightPhase(sinceLiftoff, ascent, insertion), hold: false, tMinusMs, inferred: true };
  }
  const inCountdown = tMinusMs <= countdown && tMinusMs > -60_000;
  return { phase: inCountdown ? 'COUNTDOWN' : 'SCHEDULED', hold, tMinusMs, inferred: false };
}

function inFlightPhase(sinceLiftoffMs: number, ascentMs: number, insertionMs: number): MissionPhase {
  if (sinceLiftoffMs < ascentMs) return 'ACTIVE_ASCENT';
  if (sinceLiftoffMs < ascentMs + insertionMs) return 'ORBIT_INSERTION';
  return 'ON_ORBIT';
}

/** Format a T-minus value like `T-01:23:45` / `T+00:02:10`. */
export function formatCountdown(tMinusMs: number): string {
  const sign = tMinusMs >= 0 ? '-' : '+';
  let s = Math.floor(Math.abs(tMinusMs) / 1000);
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return `T${sign}${d > 0 ? `${d}d ` : ''}${p(h)}:${p(m)}:${p(s)}`;
}
