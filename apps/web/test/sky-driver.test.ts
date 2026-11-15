import { beforeEach, describe, expect, it, vi } from 'vitest';

// Aladin and the survey servers are replaced: what is under test is which results the driver lets reach the live view.
const calls: unknown[][] = [];
const view = {
  setPose: (...a: unknown[]) => calls.push(['setPose', ...a]),
  setSurvey: (...a: unknown[]) => calls.push(['setSurvey', ...a]),
  setActive: (...a: unknown[]) => { actives.push(a[0] as boolean); return true; },
};
const actives: boolean[] = [];
const created: unknown[][] = [];
let gate: Record<string, () => void> = {};

vi.mock('../src/lib/aladin', () => ({
  loadAladin: () => Promise.resolve({}),
  createSkyView: (_A: unknown, _el: unknown, init: unknown) => { created.push([init]); return view; },
}));
vi.mock('../src/lib/hips-mirror', () => ({
  // each survey id waits until the test opens its gate, so the order of the answers is the test's
  mirrors: { pick: (id: string) => new Promise<string>((res) => { gate[id] = () => res(`https://mirror/${id}`); }) },
}));

import { SkyDriver } from '../src/ui/sky-driver';

const els = { host: {}, curtain: {}, scan: {} } as never;
const POSE = { raDeg: 120, decDeg: -10, hFovDeg: 50, rotationDeg: 20 };
const DSS = 'CDS/P/DSS2/color';
const TWOMASS = 'CDS/P/2MASS/color';
const FERMI = 'CDS/P/Fermi/color';
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  calls.length = 0;
  created.length = 0;
  actives.length = 0;
  gate = {};
});

describe('SkyDriver.prepare', () => {
  it('creates the view at the camera pose and aims it', async () => {
    const d = new SkyDriver(els);
    const p = d.prepare(DSS, () => POSE);
    await tick();
    gate[DSS]();
    await p;
    expect(created[0][0]).toMatchObject({ raDeg: 120, decDeg: -10, fovDeg: 50 });
    expect(calls).toEqual([['setPose', POSE]]);
  });

  it('a first view with no pose yet is created at a placeholder and not aimed', async () => {
    const d = new SkyDriver(els);
    const p = d.prepare(DSS, () => null);
    await tick();
    gate[DSS]();
    await p;
    expect(created).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  it('a second start with no pose yet leaves the existing view where it is (no made-up pose)', async () => {
    const d = new SkyDriver(els);
    let p = d.prepare(DSS, () => POSE);
    await tick(); gate[DSS](); await p;
    calls.length = 0;
    p = d.prepare(DSS, () => null);
    await tick(); gate[DSS](); await p;
    expect(created).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  it('a second start with another survey switches it, and aims only with a real pose', async () => {
    const d = new SkyDriver(els);
    let p = d.prepare(DSS, () => POSE);
    await tick(); gate[DSS](); await p;
    calls.length = 0;
    p = d.prepare(TWOMASS, () => null);
    await tick(); gate[TWOMASS](); await p;
    expect(calls).toEqual([['setSurvey', `https://mirror/${TWOMASS}`]]);
  });

  it('an invalidated prepare (the sky view was left while it waited) creates and aims nothing', async () => {
    const d = new SkyDriver(els);
    const p = d.prepare(DSS, () => POSE);
    await tick();
    d.invalidate();
    gate[DSS]();
    await p;
    expect(created).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('a prepare that a newer one overtook does not touch the view, the newer one does', async () => {
    const d = new SkyDriver(els);
    const old = d.prepare(DSS, () => POSE);
    await tick();
    const fresh = d.prepare(TWOMASS, () => POSE);
    await tick();
    gate[TWOMASS](); await fresh;
    gate[DSS](); await old; // the slow one answers last
    expect(created).toHaveLength(1);
    expect(created[0][0]).toMatchObject({ survey: `https://mirror/${TWOMASS}` });
  });
});

describe('SkyDriver.setActive', () => {
  it('parks and resumes the view, and a view created while parked is parked at once', async () => {
    const d = new SkyDriver(els);
    let p = d.prepare(DSS, () => POSE);
    await tick(); gate[DSS](); await p;
    expect(actives).toEqual([true]);
    d.setActive(false);
    d.setActive(true);
    expect(actives).toEqual([true, false, true]);
    // a second start while it is parked: the view is resumed by the caller before prepare, and prepare keeps that state
    d.setActive(false);
    p = d.prepare(DSS, () => POSE);
    await tick(); gate[DSS](); await p;
    expect(actives[actives.length - 1]).toBe(false);
  });

  it('before any view exists it only remembers the state', async () => {
    const d = new SkyDriver(els);
    d.setActive(false);
    expect(actives).toEqual([]);
    const p = d.prepare(DSS, () => POSE);
    await tick(); gate[DSS](); await p;
    expect(actives).toEqual([false]);
  });
});

describe('SkyDriver.useSurvey', () => {
  it('a slow answer for an earlier choice does not switch the survey back', async () => {
    const d = new SkyDriver(els);
    const p = d.prepare(DSS, () => POSE);
    await tick(); gate[DSS](); await p;
    calls.length = 0;
    const first = d.useSurvey(TWOMASS);
    await tick();
    const second = d.useSurvey(FERMI);
    await tick();
    gate[FERMI](); await second;
    gate[TWOMASS](); await first;
    expect(calls).toEqual([['setSurvey', `https://mirror/${FERMI}`]]);
  });

  it('is a no-op once invalidated', async () => {
    const d = new SkyDriver(els);
    const p = d.prepare(DSS, () => POSE);
    await tick(); gate[DSS](); await p;
    calls.length = 0;
    const u = d.useSurvey(TWOMASS);
    await tick();
    d.invalidate();
    gate[TWOMASS](); await u;
    expect(calls).toEqual([]);
  });
});
