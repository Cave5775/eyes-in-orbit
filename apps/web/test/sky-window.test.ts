import { describe, expect, it } from 'vitest';
import { MAX_FLOATS, openFloatWindow, type FloatWindow } from '../src/lib/floating';
import { SKY_WINDOW_ID, canOpenSky, canOpenStream, focusSkyWindow, openSkyWindow, openWindowCount, setSkyRect } from '../src/lib/sky-window';

const vp = { w: 1000, h: 700 };
const floats = (n: number): FloatWindow[] => {
  let l: FloatWindow[] = [];
  for (let i = 0; i < n; i++) l = openFloatWindow(l, `https://www.youtube.com/embed/abc${i}`, `s${i}`, vp);
  return l;
};

describe('sky window', () => {
  it('opens one window inside the viewport and retargets it instead of adding another', () => {
    const a = openSkyWindow(null, [], 'obs-paranal', 'Paranal', vp)!;
    expect(a.url).toBe(SKY_WINDOW_ID);
    expect(a.obsId).toBe('obs-paranal');
    expect(a.x + a.w).toBeLessThanOrEqual(vp.w);
    expect(a.y + a.h).toBeLessThanOrEqual(vp.h);
    const b = openSkyWindow(a, [], 'obs-rubin', 'Rubin', vp)!;
    expect(b.obsId).toBe('obs-rubin');
    expect(b.title).toBe('Rubin');
    expect([b.x, b.y, b.w]).toEqual([a.x, a.y, a.w]);
    expect(b.z).toBeGreaterThan(a.z);
  });

  it('shares the four-window cap with the streams, both ways', () => {
    const full = floats(MAX_FLOATS);
    expect(openSkyWindow(null, full, 'obs-rubin', 'Rubin', vp)).toBeNull();
    expect(canOpenSky(full, null)).toBe(false);
    const three = floats(MAX_FLOATS - 1);
    const sky = openSkyWindow(null, three, 'obs-rubin', 'Rubin', vp)!;
    expect(sky).not.toBeNull();
    expect(openWindowCount(three, sky)).toBe(MAX_FLOATS);
    expect(canOpenStream(three, sky)).toBe(false);
    expect(canOpenStream(three, null)).toBe(true);
    // already open: still retargetable at the cap
    expect(canOpenSky(three, sky)).toBe(true);
    // a stream opened with the sky window counted is refused
    expect(openFloatWindow(three, 'https://www.youtube.com/embed/zzz', 'x', vp, 1)).toBe(three);
  });

  it('raises above the streams and clamps moves', () => {
    const fs = floats(2);
    const sky = openSkyWindow(null, fs, 'obs-rubin', 'Rubin', vp)!;
    expect(sky.z).toBeGreaterThan(Math.max(...fs.map((f) => f.z)));
    const covered = [...fs, { ...fs[0], url: 'https://www.youtube.com/embed/top', z: sky.z + 5 }];
    expect(focusSkyWindow(sky, covered)!.z).toBe(sky.z + 6);
    const moved = setSkyRect(sky, { x: -50, y: 9999, w: 480 }, vp)!;
    expect(moved.x).toBe(0);
    expect(moved.y + moved.h).toBeLessThanOrEqual(vp.h);
    expect(setSkyRect(null, { x: 0, y: 0, w: 300 }, vp)).toBeNull();
  });
});
