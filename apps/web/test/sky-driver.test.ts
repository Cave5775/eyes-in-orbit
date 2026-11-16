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
const dead = new Set<string>(); // surveys with no server

vi.mock('../src/lib/aladin', () => ({
  loadAladin: () => Promise.resolve({}),
  createSkyView: (_A: unknown, _el: unknown, init: unknown) => { created.push([init]); return view; },
}));
vi.mock('../src/lib/hips-mirror', () => ({
  // each survey id waits until the test opens its gate, so the order of the answers is the test's
  mirrors: { pick: (id: string) => (dead.has(id) ? Promise.resolve(null) : new Promise<string>((res) => { gate[id] = () => res(`https://mirror/${id}`); })) },
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
  dead.clear();
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
    gate[FERMI](); expect(await second).toBe(true);
    gate[TWOMASS](); expect(await first).toBe(false); // overtaken: the caller must not label the survey as switched
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
    gate[TWOMASS](); expect(await u).toBe(false);
    expect(calls).toEqual([]);
  });

  it('gives up on a survey whose servers do not answer within the cap (the picker is never stuck waiting)', async () => {
    vi.useFakeTimers();
    try {
      const d = new SkyDriver(els);
      const p = d.prepare(DSS, () => POSE);
      await vi.advanceTimersByTimeAsync(0); gate[DSS](); await p;
      const u = d.useSurvey(TWOMASS); // its gate is never opened
      const assertion = expect(u).rejects.toThrow(/2MASS is unavailable right now/);
      await vi.advanceTimersByTimeAsync(5000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SkyDriver.prepare with a survey plan', () => {
  const plan = { own: ['CDS/P/HST/color', 'ESAVO/P/HST/WFC3'], fallbacks: [DSS, TWOMASS] };

  it('enters with the first fallback when every own survey is down, and says what was skipped', async () => {
    dead.add('CDS/P/HST/color').add('ESAVO/P/HST/WFC3');
    const d = new SkyDriver(els);
    const p = d.prepare(plan, () => POSE);
    await tick(); await tick();
    gate[DSS]();
    const r = await p;
    expect(r).toEqual({ used: DSS, requested: 'CDS/P/HST/color', unavailable: ['CDS/P/HST/color', 'ESAVO/P/HST/WFC3'] });
    expect(created[0][0]).toMatchObject({ survey: `https://mirror/${DSS}` });
  });

  it('uses the observatory\'s own survey when it answers, with no note to show', async () => {
    dead.add('ESAVO/P/HST/WFC3');
    const d = new SkyDriver(els);
    const p = d.prepare(plan, () => POSE);
    await tick();
    gate['CDS/P/HST/color']();
    expect(await p).toEqual({ used: 'CDS/P/HST/color', requested: 'CDS/P/HST/color', unavailable: [] });
  });

  it('fails only when no survey of the plan answers', async () => {
    for (const id of [...plan.own, ...plan.fallbacks]) dead.add(id);
    const d = new SkyDriver(els);
    await expect(d.prepare(plan, () => POSE)).rejects.toThrow(/No sky survey server answers/);
    expect(created).toEqual([]);
  });

  it('the survey picker still works after a fallback entry: a down survey rejects with a message and leaves the view alone', async () => {
    dead.add('CDS/P/HST/color').add('ESAVO/P/HST/WFC3');
    const d = new SkyDriver(els);
    const p = d.prepare(plan, () => POSE);
    await tick(); await tick();
    gate[DSS](); await p;
    calls.length = 0;
    await expect(d.useSurvey('CDS/P/HST/color')).rejects.toThrow(/Hubble colour is unavailable right now/);
    expect(calls).toEqual([]);
    const u = d.useSurvey(TWOMASS);
    await tick(); gate[TWOMASS](); await u;
    expect(calls).toEqual([['setSurvey', `https://mirror/${TWOMASS}`]]);
  });
});
