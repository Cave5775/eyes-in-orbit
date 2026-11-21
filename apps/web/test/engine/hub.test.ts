import { describe, expect, it, vi } from 'vitest';
import type { Omm } from '@eio/core';
import { Hub, keepNewerElements, type NewEntity } from '../../src/engine/hub';
import { Emitter } from '../../src/engine/emitter';

const omm = (epoch: string, mm: number): Omm => ({ OBJECT_NAME: 'STARLINK-35837', NORAD_CAT_ID: 66840, EPOCH: epoch, MEAN_MOTION: mm }) as Omm;
const sat = (epoch: string, mm: number, group = 'starlink'): NewEntity =>
  ({ id: 'sat-66840', name: 'STARLINK-35837', kind: 'satellite', bodyId: 'EARTH', group, provider: { type: 'sgp4', omm: omm(epoch, mm) } }) as NewEntity;
const elementsOf = (hub: Hub) => {
  const p = hub.graph.get('sat-66840')?.provider;
  return p?.type === 'sgp4' ? p.omm : undefined;
};

describe('Hub: SGP4 element sets from two sources', () => {
  it('an older element set does not replace a newer one, whichever source runs last', async () => {
    const hub = new Hub(0);
    hub.upsert(sat('2026-11-15T10:38:07.179360', 15.2959)); // spacetrack, current
    hub.upsert(sat('2026-10-27T16:00:03.000096', 15.2228, 'active')); // celestrak, stale snapshot
    expect(elementsOf(hub)?.EPOCH).toBe('2026-11-15T10:38:07.179360');
    expect(hub.graph.get('sat-66840')?.group).toBe('active'); // the other fields still follow the incoming record
  });

  it('a newer element set replaces an older one', async () => {
    const hub = new Hub(0);
    hub.upsert(sat('2026-10-27T16:00:03.000096', 15.2228));
    expect(hub.upsert(sat('2026-11-15T10:38:07.179360', 15.2959))).toBe(1);
    expect(elementsOf(hub)?.MEAN_MOTION).toBe(15.2959);
  });

  it('an unparseable epoch does not block the update', async () => {
    const hub = new Hub(0);
    hub.upsert(sat('2026-11-15T10:38:07', 15.2959));
    hub.upsert(sat('not a date', 15.1));
    expect(elementsOf(hub)?.MEAN_MOTION).toBe(15.1);
  });
});

describe('keepNewerElements is pure', () => {
  it('returns the incoming record unless it carries an older SGP4 epoch than the stored one', () => {
    const stored = { ...sat('2026-11-15T10:38:07', 15.2959), createdAt: 1, updatedAt: 1 } as never;
    const older = sat('2026-10-01T00:00:00', 15.1);
    expect(keepNewerElements(stored, older).provider).toBe((stored as { provider: unknown }).provider);
    const newer = sat('2026-11-16T00:00:00', 15.3);
    expect(keepNewerElements(stored, newer)).toBe(newer);
    expect(keepNewerElements(undefined, older)).toBe(older);
  });
});

describe('Hub on an injected clock', () => {
  const fakeClock = () => {
    let now = 5_000;
    const timers: { at: number; fn: () => void; id: number }[] = [];
    let n = 0;
    return {
      advance: (ms: number) => { now += ms; for (const t of timers.filter((x) => x.at <= now)) { timers.splice(timers.indexOf(t), 1); t.fn(); } },
      pending: () => timers.length,
      clock: {
        now: () => now,
        setTimeout: (fn: () => void, ms: number) => { const id = ++n; timers.push({ at: now + ms, fn, id }); return id as unknown as ReturnType<typeof setTimeout>; },
        clearTimeout: (h: unknown) => { const i = timers.findIndex((t) => t.id === h); if (i >= 0) timers.splice(i, 1); },
        setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
        clearInterval: () => {},
        random: () => 0.5,
      },
    };
  };

  it('stamps times from the clock and batches entities.changed behind the debounce', () => {
    const c = fakeClock();
    const hub = new Hub(250, c.clock);
    const seen: { ids: string[]; at: number }[] = [];
    hub.on('entities.changed', (e) => seen.push(e));
    expect(hub.upsert(sat('2026-11-15T10:38:07', 15.2959))).toBe(1);
    expect(hub.graph.get('sat-66840')).toMatchObject({ createdAt: 5_000, updatedAt: 5_000 });
    expect(c.pending()).toBe(1);
    c.advance(100);
    expect(seen).toEqual([]);
    c.advance(150);
    expect(seen).toEqual([{ ids: ['sat-66840'], at: 5_250 }]);
    expect(hub.upsert(sat('2026-11-15T10:38:07', 15.2959))).toBe(0); // unchanged: no new event
    expect(c.pending()).toBe(0);
  });

  it('flush() emits at once and drops the timer', () => {
    const c = fakeClock();
    const hub = new Hub(250, c.clock);
    const seen: string[][] = [];
    hub.on('entities.changed', (e) => seen.push(e.ids));
    hub.upsert(sat('2026-11-15T10:38:07', 15.2959));
    hub.flush();
    expect(seen).toEqual([['sat-66840']]);
    expect(c.pending()).toBe(0);
  });
});

describe('Hub state and topics', () => {
  it('counts topic subscribers and emits the count on every change', () => {
    const hub = new Hub(0);
    const events: { topic: string; count: number }[] = [];
    hub.on('topic', (e) => events.push(e));
    hub.subscribe('iss');
    hub.subscribe('iss');
    hub.unsubscribe('iss');
    hub.unsubscribe('iss');
    hub.unsubscribe('iss'); // never below zero
    expect(events.map((e) => e.count)).toEqual([1, 2, 1, 0, 0]);
    expect(hub.subscribers('iss')).toBe(0);
  });

  it('keeps launches sorted by NET and emits the data events', () => {
    const hub = new Hub(0);
    const got: string[] = [];
    hub.on('launches', (l) => got.push(l.map((x) => x.id).join()));
    hub.setLaunches([{ id: 'b', net: '2026-12-01T00:00:00Z' }, { id: 'a', net: '2026-11-01T00:00:00Z' }] as never);
    expect(got).toEqual(['a,b']);
    const news: number[] = [];
    hub.on('news', (a) => news.push(a.length));
    hub.setArticles([{ id: 1 }] as never);
    expect(news).toEqual([1]);
  });

  it('healthList carries the request budget from limitOf (sync or async) and the feed level', async () => {
    const hub = new Hub(0);
    hub.healthOf('a');
    hub.healthOf('b');
    hub.limitOf = async (id) => (id === 'a' ? { used: 1, cap: 4, window: 'hour' } : undefined);
    const list = await hub.healthList();
    expect(list.find((h) => h.id === 'a')!.limit).toMatchObject({ used: 1, cap: 4 });
    expect(list.find((h) => h.id === 'b')!.limit).toBeUndefined();
    expect(list[0].feed).toBeDefined();
  });
});

describe('Emitter', () => {
  type E = { a: number; b: string };
  it('calls listeners in order, supports off, and reports whether anyone listened', () => {
    const e = new Emitter<E>();
    const calls: string[] = [];
    const one = (n: number) => calls.push(`one${n}`);
    expect(e.emit('a', 0)).toBe(false);
    e.on('a', one).on('a', (n) => calls.push(`two${n}`));
    expect(e.emit('a', 1)).toBe(true);
    e.off('a', one);
    e.emit('a', 2);
    expect(calls).toEqual(['one1', 'two1', 'two2']);
    expect(e.listenerCount('a')).toBe(1);
  });

  it('a listener added during an emit is not called by that emit; a throwing listener propagates', () => {
    const e = new Emitter<E>();
    const late = vi.fn();
    e.on('b', () => e.on('b', late));
    e.emit('b', 'x');
    expect(late).not.toHaveBeenCalled();
    const boom = new Emitter<E>();
    boom.on('a', () => { throw new Error('listener failed'); });
    expect(() => boom.emit('a', 1)).toThrow('listener failed');
  });
});
