import type { EntityRecord } from '@eio/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../src/state/store';

const rec = (id: string, name = id): EntityRecord => ({ id, name, kind: 'satellite', bodyId: 'EARTH', aliases: {}, updatedAt: 0 });

describe('store entityChange', () => {
  beforeEach(() => useStore.setState({ entities: new Map(), entityChange: null }));

  it('a merge reports its records and the catalogue it started from', () => {
    useStore.getState().upsertEntities([rec('a'), rec('b')], true);
    const before = useStore.getState().entities;
    expect(useStore.getState().entityChange).toBeNull(); // a replace: consumers take the whole map
    const next = [rec('b', 'B2'), rec('c')];
    useStore.getState().upsertEntities(next);
    const s = useStore.getState();
    expect(s.entityChange?.records).toBe(next);
    expect(s.entityChange?.base).toBe(before);
    expect(s.entities).not.toBe(before);
    expect([...s.entities.keys()]).toEqual(['a', 'b', 'c']);
    // the base is what a consumer that saw `before` can apply the records to
    const replay = new Map(s.entityChange!.base);
    for (const r of s.entityChange!.records) replay.set(r.id, r);
    expect([...replay.entries()]).toEqual([...s.entities.entries()]);
  });

  it('consecutive merges chain: each one is based on the previous map', () => {
    const st = useStore.getState();
    st.upsertEntities([rec('a')], true);
    const m1 = useStore.getState().entities;
    st.upsertEntities([rec('b')]);
    const m2 = useStore.getState().entities;
    expect(useStore.getState().entityChange?.base).toBe(m1);
    st.upsertEntities([rec('c')]);
    expect(useStore.getState().entityChange?.base).toBe(m2);
    st.upsertEntities([rec('z')], true);
    expect(useStore.getState().entityChange).toBeNull();
  });
});

describe('store catalogShape', () => {
  const sat = (id: string, n: number, name = id): EntityRecord => ({
    ...rec(id, name), provider: { type: 'sgp4', omm: { OBJECT_NAME: name, EPOCH: '2026-11-15T00:00:00', MEAN_MOTION: n, ECCENTRICITY: 0, INCLINATION: 53, RA_OF_ASC_NODE: 0, ARG_OF_PERICENTER: 0, MEAN_ANOMALY: 0, NORAD_CAT_ID: 1 } } as EntityRecord['provider'],
  });
  it('moves on a replace, a new record or a rename, not on new SGP4 elements alone', () => {
    useStore.setState({ entities: new Map(), catalogShape: 0 });
    const st = () => useStore.getState();
    st().upsertEntities([sat('a', 15)], true);
    const s0 = st().catalogShape;
    expect(s0).toBe(1);
    st().upsertEntities([sat('a', 15.2)]); // a CelesTrak element update
    expect(st().catalogShape).toBe(s0);
    expect(st().entities.get('a')?.provider).toMatchObject({ omm: { MEAN_MOTION: 15.2 } }); // the record itself is the new one
    st().upsertEntities([sat('b', 14)]);
    expect(st().catalogShape).toBe(s0 + 1);
    st().upsertEntities([sat('a', 15.2, 'A renamed')]);
    expect(st().catalogShape).toBe(s0 + 2);
  });
});
