import { describe, expect, it } from 'vitest';
import type { Omm } from '@eio/core';
import { Hub, type NewEntity } from '../src/hub';

const omm = (epoch: string, mm: number): Omm => ({ OBJECT_NAME: 'STARLINK-35837', NORAD_CAT_ID: 66840, EPOCH: epoch, MEAN_MOTION: mm }) as Omm;
const sat = (epoch: string, mm: number, group = 'starlink'): NewEntity =>
  ({ id: 'sat-66840', name: 'STARLINK-35837', kind: 'satellite', bodyId: 'EARTH', group, provider: { type: 'sgp4', omm: omm(epoch, mm) } }) as NewEntity;
const elementsOf = (hub: Hub) => {
  const p = hub.graph.get('sat-66840')?.provider;
  return p?.type === 'sgp4' ? p.omm : undefined;
};

describe('Hub: SGP4 element sets from two sources (triage #29)', () => {
  it('an older element set does not replace a newer one, whichever source runs last', () => {
    const hub = new Hub(0);
    hub.upsert(sat('2026-11-15T10:38:07.179360', 15.2959)); // spacetrack, current
    hub.upsert(sat('2026-10-27T16:00:03.000096', 15.2228, 'active')); // celestrak, stale snapshot
    expect(elementsOf(hub)?.EPOCH).toBe('2026-11-15T10:38:07.179360');
    expect(hub.graph.get('sat-66840')?.group).toBe('active'); // the other fields still follow the incoming record
  });

  it('a newer element set replaces an older one', () => {
    const hub = new Hub(0);
    hub.upsert(sat('2026-10-27T16:00:03.000096', 15.2228));
    expect(hub.upsert(sat('2026-11-15T10:38:07.179360', 15.2959))).toBe(1);
    expect(elementsOf(hub)?.MEAN_MOTION).toBe(15.2959);
  });

  it('an unparseable epoch does not block the update', () => {
    const hub = new Hub(0);
    hub.upsert(sat('2026-11-15T10:38:07', 15.2959));
    hub.upsert(sat('not a date', 15.1));
    expect(elementsOf(hub)?.MEAN_MOTION).toBe(15.1);
  });
});
