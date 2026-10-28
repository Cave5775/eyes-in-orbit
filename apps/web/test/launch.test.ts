import { describe, expect, it } from 'vitest';
import { LL2_STATUS, type Launch } from '@eio/core';
import { liveMission } from '../src/lib/launch';

const NET = Date.parse('2026-10-22T12:00:00Z');

const launch = (vehicle: string, statusId: number = LL2_STATUS.IN_FLIGHT): Launch => ({
  id: 'l1', name: `${vehicle} | Test`, status: { id: statusId, name: 'x', abbrev: 'x' }, net: new Date(NET).toISOString(),
  windowStart: new Date(NET).toISOString(), windowEnd: new Date(NET).toISOString(), vehicle, phase: 'SCHEDULED', hold: false, entityId: 'launch-l1',
  streams: [],
} as unknown as Launch);

describe('liveMission', () => {
  it('flips to ON_ORBIT at the end of the modeled Falcon 9 flight (T+1110 s), like the server', () => {
    const f9 = launch('Falcon 9 Block 5');
    expect(liveMission(f9, NET + 509_000).phase).toBe('ACTIVE_ASCENT');
    expect(liveMission(f9, NET + 511_000).phase).toBe('ORBIT_INSERTION');
    expect(liveMission(f9, NET + 1109_000).phase).toBe('ORBIT_INSERTION');
    expect(liveMission(f9, NET + 1111_000).phase).toBe('ON_ORBIT');
  });

  it('a Go or unknown status past the insertion window is ON_ORBIT, a vehicle without a profile uses the defaults', () => {
    expect(liveMission(launch('Falcon 9 Block 5', LL2_STATUS.GO), NET + 1200_000).phase).toBe('ON_ORBIT');
    expect(liveMission(launch('Ariane 64', LL2_STATUS.GO), NET + 1200_000).phase).toBe('ON_ORBIT');
    expect(liveMission(launch('Ariane 64', LL2_STATUS.GO), NET + 600_000).phase).toBe('ORBIT_INSERTION');
  });
});
