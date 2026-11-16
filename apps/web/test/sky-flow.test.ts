import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SKY_ENTRY_TIMEOUT_MS } from '../src/lib/sky-mode';
import { mockGroundAndProbes, mockObservatories } from '../src/mock/generators';
import { runtime, type CameraCommands } from '../src/state/runtime';
import { hasSkyImagery, leaveSkyView, startSkyView } from '../src/state/sky-flow';
import { useStore } from '../src/state/store';
import { SKY_TRANSITION_KEY, createViewStore, loadSkyTransition, useView } from '../src/state/view';

const NOW = Date.parse('2026-10-22T12:00:00Z');

function fakeCamera(over: Partial<CameraCommands> = {}) {
  const calls: string[] = [];
  const cam: CameraCommands = {
    fitSelected: () => {}, fitVisible: () => {}, toggleSurface: () => {}, viewModel: () => {},
    lookFrom: (id) => { calls.push(`look ${id}`); return true; },
    leaveFirstPerson: () => { calls.push('leave'); },
    firstPersonPose: () => null, setFirstPersonLook: () => {}, setPaused: () => {}, setFirstPersonHold: () => {},
    ...over,
  };
  return { cam, calls };
}

beforeEach(() => {
  useStore.getState().upsertEntities([...mockGroundAndProbes(NOW), ...mockObservatories(NOW)], true);
  useStore.setState({ selectedId: null });
  useView.setState({ sky: { phase: 'off', obsId: null, ready: false, error: null }, firstPerson: null });
});
afterEach(() => {
  runtime.camera = undefined;
  vi.useRealTimers();
});

describe('starting and leaving the sky view', () => {
  it('knows which observatories have imagery: telescopes and ground sites yes, radio dishes no', () => {
    expect(hasSkyImagery('obs-paranal')).toBe(true);
    expect(hasSkyImagery('dsn-goldstone')).toBe(false);
    expect(hasSkyImagery('nope')).toBe(false);
  });

  it('selects the observatory, puts the camera there and only then asks for the flying phase', () => {
    const { cam, calls } = fakeCamera();
    runtime.camera = cam;
    expect(startSkyView('obs-paranal')).toBe(true);
    expect(useStore.getState().selectedId).toBe('obs-paranal');
    expect(calls).toEqual(['look obs-paranal']);
    expect(useView.getState().sky).toMatchObject({ phase: 'flying', obsId: 'obs-paranal' });
  });

  it('refuses a dish, an unknown id, a second start and a missing scene, changing nothing', () => {
    expect(startSkyView('obs-paranal')).toBe(false); // no scene mounted
    const { cam, calls } = fakeCamera();
    runtime.camera = cam;
    expect(startSkyView('dsn-goldstone')).toBe(false);
    expect(startSkyView('nope')).toBe(false);
    expect(calls).toEqual([]);
    expect(startSkyView('obs-rubin')).toBe(true);
    expect(startSkyView('obs-paranal')).toBe(false);
    expect(useView.getState().sky.obsId).toBe('obs-rubin');
  });

  it('stays off when the camera cannot stand there', () => {
    runtime.camera = fakeCamera({ lookFrom: () => false }).cam;
    expect(startSkyView('obs-paranal')).toBe(false);
    expect(useView.getState().sky.phase).toBe('off');
  });

  it('Esc before anything is shown leaves the first-person view too, and is one step', () => {
    const { cam, calls } = fakeCamera();
    runtime.camera = cam;
    startSkyView('obs-paranal');
    leaveSkyView();
    expect(useView.getState().sky.phase).toBe('off');
    expect(calls).toEqual(['look obs-paranal', 'leave']);
  });

  it('while the view covers the scene the overlay leaves the first-person view itself: the flow only moves to leaving; and leaving twice does nothing', () => {
    const { cam, calls } = fakeCamera();
    runtime.camera = cam;
    startSkyView('obs-paranal');
    useView.getState().skyDispatch({ type: 'settled' });
    useView.getState().skyDispatch({ type: 'ready' });
    useView.getState().skyDispatch({ type: 'entered' });
    expect(useView.getState().sky.phase).toBe('on');
    leaveSkyView();
    expect(useView.getState().sky.phase).toBe('leaving');
    leaveSkyView();
    expect(calls).toEqual(['look obs-paranal']);
  });

  it('gives up with a message after the entry limit and leaves the first-person view where it is', () => {
    vi.useFakeTimers();
    const { cam, calls } = fakeCamera();
    runtime.camera = cam;
    startSkyView('obs-paranal');
    vi.advanceTimersByTime(SKY_ENTRY_TIMEOUT_MS - 1);
    expect(useView.getState().sky.phase).toBe('flying');
    vi.advanceTimersByTime(2);
    expect(useView.getState().sky).toMatchObject({ phase: 'off', error: expect.stringMatching(/took too long/) });
    expect(calls).toEqual(['look obs-paranal']);
  });

  it('the limit does not hit a view that has got as far as entering', () => {
    vi.useFakeTimers();
    runtime.camera = fakeCamera().cam;
    startSkyView('obs-paranal');
    useView.getState().skyDispatch({ type: 'ready' });
    useView.getState().skyDispatch({ type: 'settled' });
    vi.advanceTimersByTime(SKY_ENTRY_TIMEOUT_MS + 10);
    expect(useView.getState().sky).toMatchObject({ phase: 'entering', error: null });
  });
});

describe('sky view state in the view store', () => {
  it('remembers the transition, falls back to crossfade, and survives blocked storage', () => {
    const data: Record<string, string> = {};
    const storage = { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v; } };
    const store = createViewStore(storage);
    expect(store.getState().skyTransition).toBe('crossfade');
    store.getState().setSkyTransition('iris');
    expect(data[SKY_TRANSITION_KEY]).toBe('iris');
    expect(createViewStore(storage).getState().skyTransition).toBe('iris');
    expect(loadSkyTransition({ getItem: () => 'wipe' })).toBe('crossfade');
    const blocked = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };
    expect(loadSkyTransition(blocked)).toBe('crossfade');
    expect(() => createViewStore(blocked).getState().setSkyTransition('cut')).not.toThrow();
  });

  it('mirrors the phase machine through skyDispatch', () => {
    const store = createViewStore(null);
    store.getState().skyDispatch({ type: 'request', obsId: 'obs-a' });
    expect(store.getState().sky.phase).toBe('flying');
    store.getState().skyDispatch({ type: 'failed', message: 'no network' });
    expect(store.getState().sky).toMatchObject({ phase: 'off', error: 'no network' });
  });
});
