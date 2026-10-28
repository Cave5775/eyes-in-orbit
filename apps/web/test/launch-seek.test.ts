import { beforeEach, describe, expect, it } from 'vitest';
import { LL2_STATUS, type Launch } from '@eio/core';
import {
  eventSimMs, jumpRate, jumpTitle, launchOfPathEntity, liftoffMsOf, netUnconfirmed, pathTipText, skipRate, skipTitle, tPlusSec,
} from '../src/lib/launch-seek';
import { plotTimeAt } from '../src/lib/ascent-chart';
import { jumpToFlightTime, jumpToSimTime, skipToLaunch } from '../src/state/seek';
import { clock } from '../src/state/runtime';

const NET = Date.parse('2026-11-01T12:00:00Z');
const launch = (over: Partial<Launch> = {}): Launch => ({
  id: 'l1', name: 'F9 | Test', status: { id: LL2_STATUS.GO, name: 'Go', abbrev: 'Go' }, net: new Date(NET).toISOString(),
  provider: 'SpaceX', entityId: 'launch-l1', streams: [], phase: 'scheduled', hold: false, ...over,
} as unknown as Launch);

describe('liftoff and event times', () => {
  it('T-0 is the NET unless the telemetry series gives its own', () => {
    expect(liftoffMsOf(launch())).toBe(NET);
    expect(liftoffMsOf(launch(), NET + 5000)).toBe(NET + 5000);
    expect(liftoffMsOf(launch({ net: 'not a date' }))).toBeNull();
    expect(liftoffMsOf(launch({ net: 'not a date' }), NET)).toBe(NET);
  });

  it('maps T+ seconds to sim time and back', () => {
    expect(eventSimMs(NET, 150)).toBe(NET + 150_000);
    expect(eventSimMs(NET, -30)).toBe(NET - 30_000);
    expect(tPlusSec(NET, NET + 150_000)).toBe(150);
  });

  it('labels the jump', () => {
    expect(jumpTitle(150)).toBe('jump to T+02:30');
    expect(jumpTitle(0)).toBe('jump to T+00:00');
    expect(netUnconfirmed(LL2_STATUS.TBD)).toBe(true);
    expect(netUnconfirmed(LL2_STATUS.TBC)).toBe(true);
    expect(netUnconfirmed(LL2_STATUS.HOLD)).toBe(false);
    expect(skipTitle(LL2_STATUS.GO, '2026-11-01 12:00:00 UTC')).not.toContain('not confirmed');
    expect(skipTitle(LL2_STATUS.TBC, 'x')).toContain('not confirmed');
  });

  it('finds the launch of a vehicle path or of its booster', () => {
    const l = launch();
    expect(launchOfPathEntity([l], 'launch-l1')).toBe(l);
    expect(launchOfPathEntity([l], 'launch-l1-booster', 'launch-l1')).toBe(l);
    expect(launchOfPathEntity([l], 'launch-zzz', 'launch-zzz-parent')).toBeUndefined();
    expect(launchOfPathEntity([l], 'x')).toBeUndefined();
  });

  it('the path tooltip counts from liftoff, else shows the UTC time', () => {
    expect(pathTipText(NET + 83_000, NET)).toBe('T+01:23 · click to jump');
    expect(pathTipText(NET - 20_000, NET)).toBe('T-00:20 · click to jump');
    expect(pathTipText(NET, null)).toBe('12:00:00 UTC · click to jump');
  });
});

describe('clock rate after a jump', () => {
  it('a jump inside a flight keeps the rate: live goes to x1, paused stays paused, a scrub keeps speed and direction', () => {
    expect(jumpRate('live', 1)).toBe(1);
    expect(jumpRate('paused', 60)).toBe(0);
    expect(jumpRate('scrubbed', 60)).toBe(60);
    expect(jumpRate('scrubbed', -10)).toBe(-10);
    expect(jumpRate('scrubbed', 0)).toBe(1);
    expect(jumpRate('scrubbed', NaN)).toBe(1);
  });

  it('skip to launch plays forward from T-0', () => {
    expect(skipRate('live', 1)).toBe(1);
    expect(skipRate('paused', 0)).toBe(1);
    expect(skipRate('scrubbed', 600)).toBe(600);
    expect(skipRate('scrubbed', -60)).toBe(60);
  });
});

describe('seeking the shared clock', () => {
  beforeEach(() => clock.goLive());

  it('skip to launch seeks to the NET at x1 from live, in the past as well as the future', () => {
    expect(skipToLaunch(launch())).toBe(true);
    let s = clock.snapshot();
    expect(s.mode).toBe('scrubbed');
    expect(s.rate).toBe(1);
    expect(Math.abs(s.nowMs - NET)).toBeLessThan(2000);
    const past = Date.parse('2019-05-24T02:30:00Z');
    expect(skipToLaunch(launch({ net: new Date(past).toISOString() }))).toBe(true);
    s = clock.snapshot();
    expect(Math.abs(s.nowMs - past)).toBeLessThan(2000);
  });

  it('a launch without a usable NET does nothing', () => {
    expect(skipToLaunch(launch({ net: '' }))).toBe(false);
    expect(clock.snapshot().mode).toBe('live');
  });

  it('a flight jump keeps a paused clock paused and a rewind rewinding', () => {
    clock.seek(NET - 3_600_000, 0);
    jumpToFlightTime(NET, 120);
    let s = clock.snapshot();
    expect(s.mode).toBe('paused');
    expect(s.nowMs).toBe(NET + 120_000);
    clock.seek(NET, -10);
    jumpToSimTime(NET + 50_000);
    s = clock.snapshot();
    expect(s.rate).toBe(-10);
    jumpToSimTime(NaN);
    expect(Math.abs(clock.snapshot().nowMs - (NET + 50_000))).toBeLessThan(2000);
  });
});

describe('plotTimeAt', () => {
  it('maps a pixel in the plot to T+ and rejects the margins', () => {
    expect(plotTimeAt(40, 40, 330, 600)).toBe(0);
    expect(plotTimeAt(330, 40, 330, 600)).toBe(600);
    expect(plotTimeAt(185, 40, 330, 600)).toBe(300);
    expect(plotTimeAt(39, 40, 330, 600)).toBeNull();
    expect(plotTimeAt(331, 40, 330, 600)).toBeNull();
    expect(plotTimeAt(NaN, 40, 330, 600)).toBeNull();
  });
});
