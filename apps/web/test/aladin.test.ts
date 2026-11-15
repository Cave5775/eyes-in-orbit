import { afterEach, describe, expect, it, vi } from 'vitest';
import { ALADIN_URL, ALADIN_VERSION, MAX_FOV_DEG, aladinRotationDeg, createSkyView, liveSkyView, loadAladin, resetAladinLoader, resetLiveSkyView, type AladinGlobal } from '../src/lib/aladin';

function fakeAladin() {
  const calls: unknown[][] = [];
  const handlers: Record<string, (n: number) => void> = {};
  const inst = {
    gotoRaDec: (...a: number[]) => calls.push(['goto', ...a]),
    setFoV: (...a: number[]) => calls.push(['fov', ...a]),
    setImageSurvey: (...a: string[]) => calls.push(['survey', ...a]),
    getFoV: () => [12, 8],
    getRaDec: () => [33, -44],
    setRotation: (...a: number[]) => calls.push(['rot', ...a]),
    getRotation: () => -30,
    world2pix: (ra: number, dec: number) => [ra * 2, dec * 3],
    pix2world: (x: number, y: number) => (x < 0 ? null : [x / 2, y / 3]),
    on: (...a: unknown[]) => { calls.push(['on', a[0]]); handlers[String(a[0])] = a[1] as (n: number) => void; },
  };
  const A: AladinGlobal = { init: Promise.resolve(), aladin: (_el, o) => { calls.push(['create', o]); return inst; } };
  return { A, calls, handlers };
}

afterEach(() => { resetAladinLoader(); resetLiveSkyView(); vi.useRealTimers(); });

describe('aladin adapter', () => {
  it('pins an exact released version on the jsDelivr CDN', () => {
    expect(ALADIN_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(ALADIN_URL).toBe(`https://cdn.jsdelivr.net/npm/aladin-lite@${ALADIN_VERSION}/dist/aladin.js`);
  });

  it('imports the module once, waits for A.init and resolves with the default export; a second call reuses it', async () => {
    const { A } = fakeAladin();
    const importer = vi.fn(async () => ({ default: A }));
    expect(await loadAladin(importer)).toBe(A);
    expect(importer).toHaveBeenCalledWith(ALADIN_URL);
    expect(await loadAladin(importer)).toBe(A);
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it('also accepts a named A export or the module itself', async () => {
    const { A } = fakeAladin();
    expect(await loadAladin(async () => ({ A }))).toBe(A);
    resetAladinLoader();
    expect(await loadAladin(async () => A)).toBe(A);
  });

  it('rejects with a readable message when the import fails, and retries next time', async () => {
    const importer = vi.fn(async () => { throw new Error('Failed to fetch dynamically imported module'); });
    await expect(loadAladin(importer)).rejects.toThrow(/Could not load Aladin Lite .*Failed to fetch/);
    await expect(loadAladin(importer)).rejects.toThrow(/Could not load/);
    expect(importer).toHaveBeenCalledTimes(2);
  });

  it('rejects when the module has no Aladin, when init fails, and on a timeout', async () => {
    await expect(loadAladin(async () => ({ default: {} }))).rejects.toThrow(/no Aladin export/);
    const bad: AladinGlobal = { init: Promise.reject(new Error('wasm')), aladin: () => { throw new Error('unused'); } };
    await expect(loadAladin(async () => ({ default: bad }))).rejects.toThrow(/initialisation failed/);
    vi.useFakeTimers();
    const p = loadAladin(() => new Promise(() => {}), ALADIN_URL, 1000);
    const assertion = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
  });

  it('rejects without a browser', async () => {
    await expect(loadAladin(null)).rejects.toThrow(/browser/);
  });

  it('createSkyView passes the start point and forwards the few calls the app uses', () => {
    const { A, calls } = fakeAladin();
    const v = createSkyView(A, {} as HTMLElement, { survey: 'CDS/P/DSS2/color', raDeg: 10.5, decDeg: -20, fovDeg: 30 });
    expect(calls[0][1]).toMatchObject({ survey: 'CDS/P/DSS2/color', target: '10.5 -20', fov: 30, cooFrame: 'equatorial', projection: 'TAN' });
    v.gotoRaDec(1, 2);
    v.setSurvey('CDS/P/2MASS/color');
    v.setFov(5);
    expect(calls.slice(2)).toEqual([['goto', 1, 2], ['survey', 'CDS/P/2MASS/color'], ['fov', 5]]);
    expect(v.fov()).toBe(12);
  });

  it('animateTo uses Aladin own animation (seconds) and stopAnimation stops it', () => {
    const { A, calls } = fakeAladin();
    const inst = A.aladin({} as HTMLElement, {});
    const own = { ...inst, animateToRaDec: (...a: number[]) => calls.push(['anim', ...a]), stopAnimation: () => calls.push(['stop']) };
    const v = createSkyView({ init: A.init, aladin: () => own }, {} as HTMLElement, { survey: 's', raDeg: 0, decDeg: 0, fovDeg: 30 });
    calls.length = 0;
    v.animateTo(130, 40, 400);
    expect(calls).toEqual([['stop'], ['anim', 130, 40, 0.4]]);
    v.stopAnimation();
    expect(calls[calls.length - 1]).toEqual(['stop']);
  });

  it('animateTo without Aladin animation steps gotoRaDec along an eased great circle and ends exactly on the target', () => {
    const { A, calls } = fakeAladin(); // getRaDec says (33, -44)
    const v = createSkyView(A, {} as HTMLElement, { survey: 's', raDeg: 0, decDeg: 0, fovDeg: 30 });
    let now = 0;
    const frames: (() => void)[] = [];
    vi.stubGlobal('performance', { now: () => now });
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => { frames.length = 0; });
    try {
      calls.length = 0;
      v.animateTo(60, 10, 400);
      expect(calls).toHaveLength(1); // the first step runs at once, at the start
      expect(calls[0][1]).toBeCloseTo(33, 6);
      now = 200; frames.shift()!();
      expect(calls).toHaveLength(2);
      expect(calls[1][1]).toBeGreaterThan(33); expect(calls[1][1]).toBeLessThan(60);
      now = 400; frames.shift()!();
      expect(calls[calls.length - 1]).toEqual(['goto', 60, 10]);
      expect(frames).toHaveLength(0);
      // a new call replaces a running one
      now = 0; v.animateTo(1, 1, 400);
      v.stopAnimation();
      expect(frames).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('createSkyView caps the field of view at MAX_FOV_DEG (the TAN projection stretches without bound)', () => {
    const { A, calls, handlers } = fakeAladin();
    createSkyView(A, {} as HTMLElement, { survey: 'CDS/P/DSS2/color', raDeg: 0, decDeg: 0, fovDeg: 30 });
    calls.length = 0;
    handlers.zoomChanged(60);
    expect(calls).toEqual([]);
    handlers.zoomChanged(170);
    expect(calls).toEqual([['fov', MAX_FOV_DEG]]);
  });

  it('setPose aims, sets the horizontal field (clamped) and rotates by minus the position angle', () => {
    const { A, calls } = fakeAladin();
    const v = createSkyView(A, {} as HTMLElement, { survey: 'x', raDeg: 0, decDeg: 0, fovDeg: 30 });
    calls.length = 0;
    v.setPose({ raDeg: 120, decDeg: -10, hFovDeg: 80, rotationDeg: 25 });
    expect(calls).toEqual([['goto', 120, -10], ['fov', 80], ['rot', -25]]);
    calls.length = 0;
    v.setPose({ raDeg: 1, decDeg: 2, hFovDeg: 400, rotationDeg: 0 });
    expect(calls).toEqual([['goto', 1, 2], ['fov', MAX_FOV_DEG], ['rot', 1e-6]]);
  });

  it('aladinRotationDeg flips the sign, never sends zero and survives junk', () => {
    expect(aladinRotationDeg(30)).toBe(-30);
    expect(aladinRotationDeg(-170)).toBe(170);
    expect(aladinRotationDeg(0)).toBe(1e-6);
    expect(aladinRotationDeg(Number.NaN)).toBe(1e-6);
  });

  it('reads the centre, the rotation and the projection back, and has no rotation when the build lacks it', () => {
    const { A } = fakeAladin();
    const v = createSkyView(A, {} as HTMLElement, { survey: 'x', raDeg: 0, decDeg: 0, fovDeg: 30 });
    expect(v.center()).toEqual({ raDeg: 33, decDeg: -44 });
    expect(v.rotation()).toBe(-30);
    expect(v.world2pix(10, 20)).toEqual([20, 60]);
    expect(v.pix2world(20, 60)).toEqual([10, 20]);
    expect(v.pix2world(-1, 0)).toBeNull();
    const bare: AladinGlobal = { aladin: () => ({ gotoRaDec() {}, setFoV() {}, getFoV: () => 7, setImageSurvey() {}, on() {} }) };
    const b = createSkyView(bare, {} as HTMLElement, { survey: 'x', raDeg: 0, decDeg: 0, fovDeg: 30 });
    expect(b.rotation()).toBeNull();
    expect(b.world2pix(1, 2)).toBeNull();
    expect(b.center()).toBeNull();
    expect(b.fov()).toBe(7);
    expect(() => b.setPose({ raDeg: 1, decDeg: 2, hFovDeg: 3, rotationDeg: 4 })).not.toThrow();
  });

  it('keeps the created view reachable for an overlay that projects sky positions', () => {
    expect(liveSkyView()).toBeNull();
    const { A } = fakeAladin();
    const v = createSkyView(A, {} as HTMLElement, { survey: 'x', raDeg: 0, decDeg: 0, fovDeg: 30 });
    expect(liveSkyView()).toBe(v);
    resetLiveSkyView();
    expect(liveSkyView()).toBeNull();
  });
});
