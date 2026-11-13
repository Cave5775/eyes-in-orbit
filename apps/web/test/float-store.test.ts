import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_FLOATS } from '../src/lib/floating';
import { useStore } from '../src/state/store';

const yt = (i: number) => `https://www.youtube.com/embed/vid${i}`;
const st = () => useStore.getState();

beforeEach(() => useStore.setState({ floats: [], sky: null }));

describe('floating windows in the store: streams and the Sky view share the z order and the cap', () => {
  it('raising a stream puts it above the Sky window and raising the Sky window puts it above the streams', () => {
    expect(st().openFloat(yt(1), 'a')).toBe(true);
    expect(st().openSky('obs-paranal', 'Sky')).toBe(true);
    expect(st().sky!.z).toBeGreaterThan(st().floats[0].z);
    st().focusFloat(yt(1));
    expect(st().floats[0].z).toBeGreaterThan(st().sky!.z);
    st().focusSky();
    expect(st().sky!.z).toBeGreaterThan(st().floats[0].z);
    // a new stream opens above the Sky window too
    expect(st().openFloat(yt(2), 'b')).toBe(true);
    const b = st().floats.find((f) => f.url === yt(2))!;
    expect(b.z).toBeGreaterThan(st().sky!.z);
  });

  it('openFloat refuses (false, nothing added) when the Sky window takes the last slot, and Sky is refused when streams fill it', () => {
    for (let i = 0; i < MAX_FLOATS - 1; i++) expect(st().openFloat(yt(i), `s${i}`)).toBe(true);
    expect(st().openSky('obs-rubin', 'Sky')).toBe(true);
    expect(st().openFloat(yt(99), 'late')).toBe(false);
    expect(st().floats).toHaveLength(MAX_FLOATS - 1);
    // an already open stream is only raised
    expect(st().openFloat(yt(0), 's0')).toBe(true);
    st().closeSky();
    expect(st().openFloat(yt(99), 'late')).toBe(true);
    expect(st().openSky('obs-rubin', 'Sky')).toBe(false);
    expect(st().sky).toBeNull();
  });

  it('openFloat refuses a URL that cannot be floated', () => {
    expect(st().openFloat('https://example.com/x', 'nope')).toBe(false);
    expect(st().floats).toHaveLength(0);
  });
});

describe('minimize in the store', () => {
  it('toggles a stream window and the Sky window, keeps the rect, and the cap still counts them', () => {
    expect(st().openFloat(yt(1), 'a')).toBe(true);
    const rect = { x: st().floats[0].x, y: st().floats[0].y, w: st().floats[0].w };
    st().toggleFloatMinimized(yt(1));
    expect(st().floats[0].minimized).toBe(true);
    expect(st().floats[0]).toMatchObject(rect);
    expect(st().openSky('obs-paranal', 'Sky')).toBe(true);
    st().toggleSkyMinimized();
    expect(st().sky!.minimized).toBe(true);
    for (let i = 2; i < MAX_FLOATS; i++) expect(st().openFloat(yt(i), `s${i}`)).toBe(true);
    expect(st().openFloat(yt(99), 'late')).toBe(false);
    st().toggleFloatMinimized(yt(1));
    st().toggleSkyMinimized();
    expect(st().floats[0].minimized).toBe(false);
    expect(st().sky!.minimized).toBe(false);
  });
});
