import type { EntityRecord } from '@eio/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REMOTE_TEXT_DELAY_MS, SERVER_SEARCH_MIN, textHitsOf, type MatchAnswer } from '../src/lib/text-match';
import { setTextMatcher, useStore } from '../src/state/store';

const rec = (i: number, name = `SAT ${i}`): EntityRecord => ({ id: `s${i}`, name, kind: 'satellite', bodyId: 'EARTH', aliases: {}, updatedAt: 0 });
const big = (): Map<string, EntityRecord> => new Map(Array.from({ length: SERVER_SEARCH_MIN }, (_, i) => [`s${i}`, rec(i)]));

const deferred = <T>() => {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};
const answer = (ids: string[], truncated = false): MatchAnswer => ({ ids, total: ids.length, truncated });
const st = () => useStore.getState();
const flush = async () => { await vi.advanceTimersByTimeAsync(REMOTE_TEXT_DELAY_MS + 1); };

beforeEach(() => {
  vi.useFakeTimers();
  setTextMatcher(null);
  useStore.setState({ entities: new Map(), entityChange: null, textHits: null, textIds: null });
  st().clearQuery();
});
afterEach(() => {
  setTextMatcher(null);
  vi.useRealTimers();
});

describe('text search through the server', () => {
  it('a small catalogue is ranked locally, at once, and the server is not asked', async () => {
    const match = vi.fn();
    setTextMatcher(match);
    useStore.setState({ entities: new Map([['s1', rec(1, 'STARLINK-1')], ['s2', rec(2, 'ISS')]]) });
    st().setText('starl');
    expect(st().textHits?.map((h) => h.id)).toEqual(['s1']);
    await flush();
    expect(match).not.toHaveBeenCalled();
  });

  it('with no server (the offline mock) even a big catalogue is ranked locally', () => {
    useStore.setState({ entities: big() });
    st().setText('sat 19');
    expect(st().textHits!.length).toBeGreaterThan(0);
    expect(st().textIds!.has('s19')).toBe(true);
  });

  it('a big catalogue asks the server after a pause, shows nothing meanwhile, then the answer in the server order', async () => {
    const d = deferred<MatchAnswer>();
    const match = vi.fn(() => d.promise);
    setTextMatcher(match);
    useStore.setState({ entities: big() });
    st().setText('sat 7');
    expect(st().textIds).toEqual(new Set()); // pending: nothing matches yet, not everything
    expect(match).not.toHaveBeenCalled(); // waiting for the typing to pause
    await flush();
    expect(match).toHaveBeenCalledWith('sat 7');
    d.resolve(answer(['s77', 's7', 'missing-id', 's700']));
    await vi.advanceTimersByTimeAsync(0);
    expect(st().textHits?.map((h) => h.id)).toEqual(['s77', 's7', 's700']); // an id this client does not hold is skipped
    expect(st().textIds).toEqual(new Set(['s77', 's7', 's700']));
  });

  it('typing fast sends one request, and a newer query keeps the previous answer until its own arrives', async () => {
    const answers: Record<string, ReturnType<typeof deferred<MatchAnswer>>> = {};
    const match = vi.fn((t: string) => (answers[t] = deferred<MatchAnswer>()).promise);
    setTextMatcher(match);
    useStore.setState({ entities: big() });
    st().setText('sat 1');
    await vi.advanceTimersByTimeAsync(50);
    st().setText('sat 12');
    st().setText('sat 123');
    await flush();
    expect(match.mock.calls.map((c) => c[0])).toEqual(['sat 123']); // the pauses restarted: one request
    answers['sat 123'].resolve(answer(['s123']));
    await vi.advanceTimersByTimeAsync(0);
    expect(st().textHits?.map((h) => h.id)).toEqual(['s123']);
    st().setText('sat 1234'); // the previous answer stays while the next is awaited
    expect(st().textHits?.map((h) => h.id)).toEqual(['s123']);
    await flush();
    answers['sat 1234'].resolve(answer(['s1234']));
    await vi.advanceTimersByTimeAsync(0);
    expect(st().textHits?.map((h) => h.id)).toEqual(['s1234']);
  });

  it('an answer that arrives after a newer query, or after the text was cleared, is ignored', async () => {
    const answers: Record<string, ReturnType<typeof deferred<MatchAnswer>>> = {};
    setTextMatcher((t) => (answers[t] = deferred<MatchAnswer>()).promise);
    useStore.setState({ entities: big() });
    st().setText('sat 1');
    await flush();
    st().setText('sat 2');
    await flush();
    answers['sat 2'].resolve(answer(['s2']));
    await vi.advanceTimersByTimeAsync(0);
    answers['sat 1'].resolve(answer(['s1'])); // late
    await vi.advanceTimersByTimeAsync(0);
    expect(st().textHits?.map((h) => h.id)).toEqual(['s2']);
    st().setText('');
    expect(st().textHits).toBeNull();
    answers['sat 2'].resolve(answer(['s2', 's20']));
    await vi.advanceTimersByTimeAsync(0);
    expect(st().textHits).toBeNull();
  });

  it('a truncated answer is ranked locally instead (the server cut the list)', async () => {
    setTextMatcher(async () => answer(['s1'], true));
    useStore.setState({ entities: big() });
    st().setText('sat 19');
    await flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(st().textIds!.size).toBeGreaterThan(1); // the local pass found all of them, not just the server's one id
    expect(st().textIds!.has('s19')).toBe(true);
    expect(st().textIds!.has('s190')).toBe(true);
  });

  it('a failed request falls back to the local ranking', async () => {
    setTextMatcher(async () => { throw new Error('HTTP 500'); });
    useStore.setState({ entities: big() });
    st().setText('sat 19');
    await flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(st().textIds!.has('s19')).toBe(true);
  });

  it('textHitsOf keeps the server order', () => {
    const e = new Map([['s1', rec(1, 'A')], ['s2', rec(2, 'B')]]);
    expect(textHitsOf(['s2', 'x', 's1'], e).map((h) => h.id)).toEqual(['s2', 's1']);
  });
});
