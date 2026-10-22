import { LL2_STATUS, deriveMissionState, type Launch, type MissionState } from '@eio/core';

/** Re-derive phase and T-minus for `launch` at sim time `nowMs` (server phases are only refreshed every 15 s). */
export function liveMission(launch: Launch, nowMs: number): MissionState {
  return deriveMissionState({ statusId: launch.status.id, netMs: Date.parse(launch.net), nowMs });
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
