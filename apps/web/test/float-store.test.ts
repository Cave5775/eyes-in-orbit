import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_FLOATS, canOpenStream } from '../src/lib/floating';
import { useStore } from '../src/state/store';

const yt = (i: number) => `https://www.youtube.com/embed/vid${i}`;
const st = () => useStore.getState();

beforeEach(() => useStore.setState({ floats: [] }));

describe('floating windows in the store: the stream windows share the z order and the cap', () => {
  it('raising a stream puts it above the others, and a new stream opens above all', () => {
    expect(st().openFloat(yt(1), 'a')).toBe(true);
    expect(st().openFloat(yt(2), 'b')).toBe(true);
    const z = (u: string) => st().floats.find((f) => f.url === u)!.z;
    expect(z(yt(2))).toBeGreaterThan(z(yt(1)));
    st().focusFloat(yt(1));
    expect(z(yt(1))).toBeGreaterThan(z(yt(2)));
    expect(st().openFloat(yt(3), 'c')).toBe(true);
    expect(z(yt(3))).toBeGreaterThan(z(yt(1)));
  });

  it('openFloat refuses (false, nothing added) at the cap, and only raises a stream that is already open', () => {
    for (let i = 0; i < MAX_FLOATS; i++) expect(st().openFloat(yt(i), `s${i}`)).toBe(true);
    expect(canOpenStream(st().floats)).toBe(false);
    expect(st().openFloat(yt(99), 'late')).toBe(false);
    expect(st().floats).toHaveLength(MAX_FLOATS);
    expect(st().openFloat(yt(0), 's0')).toBe(true);
    expect(st().floats).toHaveLength(MAX_FLOATS);
    st().closeFloat(yt(0));
    expect(canOpenStream(st().floats)).toBe(true);
    expect(st().openFloat(yt(99), 'late')).toBe(true);
  });

  it('openFloat refuses a URL that cannot be floated', () => {
    expect(st().openFloat('https://example.com/x', 'nope')).toBe(false);
    expect(st().floats).toHaveLength(0);
  });
});

describe('minimize in the store', () => {
  it('toggles a stream window, keeps the rect, and the cap still counts it', () => {
    expect(st().openFloat(yt(1), 'a')).toBe(true);
    const rect = { x: st().floats[0].x, y: st().floats[0].y, w: st().floats[0].w };
    st().toggleFloatMinimized(yt(1));
    expect(st().floats[0].minimized).toBe(true);
    expect(st().floats[0]).toMatchObject(rect);
    for (let i = 2; i <= MAX_FLOATS; i++) expect(st().openFloat(yt(i), `s${i}`)).toBe(true);
    expect(st().openFloat(yt(99), 'late')).toBe(false);
    st().toggleFloatMinimized(yt(1));
    expect(st().floats[0].minimized).toBe(false);
  });
});
