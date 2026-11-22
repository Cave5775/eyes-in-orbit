import { describe, expect, it, vi } from 'vitest';
import { watchMinorPlanets } from '../src/lib/minor-planet-watch';
import { describeMinorPlanets } from '../src/state/minor-planet-status';

/** a view store with only the flag the watcher reads */
function fakeView(initial: boolean) {
  let state = { minorPlanets: initial };
  const subs = new Set<(s: { minorPlanets: boolean }) => void>();
  return {
    view: { getState: () => state, subscribe: (fn: (s: { minorPlanets: boolean }) => void) => (subs.add(fn), () => subs.delete(fn)) },
    set: (minorPlanets: boolean) => { state = { minorPlanets }; subs.forEach((f) => f(state)); },
  };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('minor planets are downloaded only on request', () => {
  const api = () => ({
    minorPlanetsStatus: vi.fn(async () => ({ state: 'none' as const })),
    minorPlanetsDownload: vi.fn(async () => ({ state: 'ready' as const, count: 20 })),
    minorPlanetsCancel: vi.fn(async () => undefined),
  });

  it('asks for the state at startup but downloads nothing while the layer is off', async () => {
    const a = api();
    const { view } = fakeView(false);
    watchMinorPlanets(() => a, view, vi.fn());
    await flush();
    expect(a.minorPlanetsStatus).toHaveBeenCalledTimes(1);
    expect(a.minorPlanetsDownload).not.toHaveBeenCalled();
  });

  it('turning the layer on starts the download and shows its result; turning it off aborts', async () => {
    const a = api();
    const set = vi.fn();
    const v = fakeView(false);
    watchMinorPlanets(() => a, v.view, set);
    v.set(true);
    await flush();
    expect(a.minorPlanetsDownload).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenLastCalledWith({ state: 'ready', count: 20 });
    v.set(false);
    expect(a.minorPlanetsCancel).toHaveBeenCalledTimes(1);
    v.set(false); // no change, no second call
    expect(a.minorPlanetsCancel).toHaveBeenCalledTimes(1);
  });

  it('a layer that was left on starts the check at startup, and unsubscribing stops the watch', async () => {
    const a = api();
    const v = fakeView(true);
    const off = watchMinorPlanets(() => a, v.view, vi.fn());
    await flush();
    expect(a.minorPlanetsDownload).toHaveBeenCalledTimes(1);
    off();
    v.set(false);
    expect(a.minorPlanetsCancel).not.toHaveBeenCalled();
  });
});

describe('minor-planet state text', () => {
  it('says what is happening, with a button where one makes sense', () => {
    expect(describeMinorPlanets({ state: 'none' })).toMatchObject({ button: 'Download', text: expect.stringContaining('70 MB') });
    expect(describeMinorPlanets({ state: 'downloading', phase: 'downloading' })).toMatchObject({ button: '', text: expect.stringContaining('Downloading and unpacking') });
    expect(describeMinorPlanets({ state: 'downloading', phase: 'storing' }).text).toMatch(/Saving/);
    expect(describeMinorPlanets({ state: 'ready', count: 1_400_000, fetchedAt: Date.parse('2026-11-18T00:00:00Z') })).toMatchObject({ button: 'Refresh', text: expect.stringContaining('1,400,000 orbits') });
    expect(describeMinorPlanets({ state: 'failed', error: 'HTTP 503', count: 5 })).toMatchObject({ button: 'Retry', text: expect.stringContaining('HTTP 503') });
  });
});
