import { afterEach, describe, expect, it, vi } from 'vitest';
import { ALADIN_URL, ALADIN_VERSION, createSkyView, loadAladin, resetAladinLoader, type AladinGlobal } from '../src/lib/aladin';

function fakeAladin() {
  const calls: unknown[][] = [];
  const inst = {
    gotoRaDec: (...a: number[]) => calls.push(['goto', ...a]),
    setFoV: (...a: number[]) => calls.push(['fov', ...a]),
    setImageSurvey: (...a: string[]) => calls.push(['survey', ...a]),
    getFoV: () => [12, 8],
  };
  const A: AladinGlobal = { init: Promise.resolve(), aladin: (_el, o) => { calls.push(['create', o]); return inst; } };
  return { A, calls };
}

afterEach(() => { resetAladinLoader(); vi.useRealTimers(); });

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
    expect(calls[0][1]).toMatchObject({ survey: 'CDS/P/DSS2/color', target: '10.5 -20', fov: 30, cooFrame: 'equatorial' });
    v.gotoRaDec(1, 2);
    v.setSurvey('CDS/P/2MASS/color');
    v.setFov(5);
    expect(calls.slice(1)).toEqual([['goto', 1, 2], ['survey', 'CDS/P/2MASS/color'], ['fov', 5]]);
    expect(v.fov()).toBe(12);
  });
});
