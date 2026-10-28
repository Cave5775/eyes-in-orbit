import { LL2_STATUS, deriveMissionState, missionTimingFor, type Launch, type MissionState } from '@eio/core';

/**
 * Re-derive phase and T-minus for `launch` at sim time `nowMs` (server phases are only refreshed every 15 s). The ascent and
 * insertion durations are the launch vehicle's own (`missionTimingFor`), the same the server passes, so the phase flips at the
 * moments the modeled flight does (ON_ORBIT from T+1110 s for Falcon 9).
 */
export function liveMission(launch: Launch, nowMs: number): MissionState {
  return deriveMissionState({ statusId: launch.status.id, netMs: Date.parse(launch.net), nowMs, ...missionTimingFor(launch) });
}

export type ChipTone = 'ok' | 'warn' | 'bad' | 'dim';

export function statusTone(statusId: number): ChipTone {
  switch (statusId) {
    case LL2_STATUS.GO:
    case LL2_STATUS.SUCCESS:
    case LL2_STATUS.IN_FLIGHT:
      return 'ok';
    case LL2_STATUS.HOLD:
      return 'warn';
    case LL2_STATUS.FAILURE:
    case LL2_STATUS.PARTIAL_FAILURE:
      return 'bad';
    default:
      return 'dim';
  }
}
