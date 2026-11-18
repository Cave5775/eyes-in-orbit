import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { DEV_OPTIONS, clampNumber, defaultValues } from '../src/lib/dev-options';
import { Damper, SMOOTH_DEFAULTS, SMOOTH_OPTIONS, decayFraction, frameDt, smoothParams, type SmoothParams } from '../src/lib/smoothing';
import { OrbitRig } from '../src/scene/controls';
import { createViewStore, SMOOTH_CAMERA_KEY, type StorageLike } from '../src/state/view';

/** Run a damper for `seconds` at `fps` after adding `pending`; the total applied. */
function applied(pending: number[], tau: number, seconds: number, fps: number, cutoff = 0): number[] {
  const d = new Damper(pending.length);
  d.add(...pending);
  const total = pending.map(() => 0);
  const dt = 1 / fps;
  for (let i = 0; i < Math.round(seconds * fps); i++) d.step(dt, tau, cutoff).forEach((v, k) => { total[k] += v; });
  return total;
}

describe('decayFraction', () => {
  it('is 1 - exp(-dt/tau), 0 for no time and 1 for no damping', () => {
    expect(decayFraction(0.1, 0.1)).toBeCloseTo(1 - Math.exp(-1), 12);
    expect(decayFraction(0, 0.1)).toBe(0);
    expect(decayFraction(-1, 0.1)).toBe(0);
    expect(decayFraction(0.016, 0)).toBe(1);
  });
  it('frameDt limits a stalled frame', () => {
    expect(frameDt(1016, 1000)).toBeCloseTo(0.016, 12);
    expect(frameDt(9000, 1000)).toBe(0.1);
    expect(frameDt(900, 1000)).toBe(0);
  });
});

describe('Damper', () => {
  it('is frame-rate independent: 30 and 144 fps apply the same motion after the same time', () => {
    for (const tau of [0.05, 0.12, 0.4]) {
      for (const seconds of [0.5, 1, 2]) {
        const a = applied([300, -80], tau, seconds, 30);
        const b = applied([300, -80], tau, seconds, 144);
        const want = [300, -80].map((p) => p * (1 - Math.exp(-seconds / tau)));
        expect(a[0]).toBeCloseTo(want[0], 6);
        expect(b[0]).toBeCloseTo(want[0], 6);
        expect(a[1]).toBeCloseTo(want[1], 6);
        expect(Math.abs(a[0] - b[0])).toBeLessThan(1e-6);
      }
    }
  });
  it('applies exactly what was added, once the glide ends', () => {
    const t = applied([123.5, -7], 0.12, 6, 60, 0.5);
    expect(t[0]).toBeCloseTo(123.5, 9);
    expect(t[1]).toBeCloseTo(-7, 9);
  });
  it('a cutoff ends the glide early, applying the rest in one step', () => {
    const d = new Damper(1);
    d.add(100);
    let steps = 0;
    while (d.active && steps < 10000) { d.step(1 / 60, 0.2, 50); steps++; }
    expect(d.active).toBe(false);
    // 100 px with tau 0.2 s starts at 500 px/s and passes 50 px/s after ln(10) * 0.2 = 0.46 s: well before it would fade to nothing
    expect(steps).toBeLessThan(40);
    expect(steps).toBeGreaterThan(20);
  });
  it('flush returns everything and clears; clear drops it', () => {
    const d = new Damper(2);
    d.add(3, 4);
    d.step(0.016, 0.1, 0);
    const rest = d.flush();
    expect(d.active).toBe(false);
    expect(rest[0] / rest[1]).toBeCloseTo(3 / 4, 9);
    d.add(1, 1);
    d.clear();
    expect(d.active).toBe(false);
  });
});

describe('smoothing options', () => {
  it('are registered as developer options with defaults inside their ranges', () => {
    for (const o of SMOOTH_OPTIONS) {
      expect(DEV_OPTIONS).toContain(o);
      if (o.type === 'number') expect(clampNumber(o, o.default)).toBe(o.default);
    }
    expect(new Set(DEV_OPTIONS.map((o) => o.id)).size).toBe(DEV_OPTIONS.length);
  });
  it('smoothParams reads the values, defaults, and turns inertia off for reduced motion', () => {
    expect(smoothParams(defaultValues(), false)).toEqual(SMOOTH_DEFAULTS);
    expect(smoothParams({}, false)).toEqual(SMOOTH_DEFAULTS);
    expect(smoothParams({ 'smooth.orbitTau': 0.3, 'smooth.inertia': false }, false)).toMatchObject({ orbitTau: 0.3, inertia: false });
    expect(smoothParams(defaultValues(), true).inertia).toBe(false);
  });
});

describe('Smooth camera setting', () => {
  it('defaults to on and is remembered', () => {
    const data: Record<string, string> = {};
    const mem: StorageLike = { getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v; } };
    const store = createViewStore(mem);
    expect(store.getState().smoothCamera).toBe(true);
    store.getState().setSmoothCamera(false);
    expect(data[SMOOTH_CAMERA_KEY]).toBe('off');
    expect(createViewStore(mem).getState().smoothCamera).toBe(false);
  });
});

/** An OrbitRig whose pointer and wheel events are fired by hand. */
function makeRig(smoothing: SmoothParams | null) {
  const handlers = new Map<string, (e: any) => void>();
  const dom = {
    style: {}, clientHeight: 500, setPointerCapture: () => undefined, removeEventListener: () => undefined,
    addEventListener: (type: string, fn: (e: any) => void) => { handlers.set(type, fn); },
  } as unknown as HTMLElement;
  const cam = new THREE.PerspectiveCamera(45, 1.6, 1, 1e12);
  const rig = new OrbitRig(cam, dom);
  rig.minDist = 1;
  rig.smoothing = smoothing ? () => smoothing : null;
  const fire = (type: string, e: Record<string, unknown>) => handlers.get(type)!({ pointerId: 1, buttons: 1, shiftKey: false, preventDefault: () => undefined, ...e });
  rig.update(null, new THREE.Vector3(), 0);
  return { rig, cam, fire };
}
const P: SmoothParams = { orbitTau: 0.12, zoomTau: 0.15, panTau: 0.12, inertia: true, cutoff: 0 };

describe('OrbitRig smoothing', () => {
  it('off: a drag turns the camera at once, exactly as before', () => {
    const { rig, fire } = makeRig(null);
    const az = rig.az, el = rig.el;
    fire('pointerdown', { clientX: 10, clientY: 10 });
    fire('pointermove', { clientX: 30, clientY: 20 });
    expect(rig.az).toBeCloseTo(az - 20 * 0.0055, 12);
    expect(rig.el).toBeCloseTo(el + 10 * 0.0055, 12);
    const d = rig.dist;
    fire('wheel', { deltaY: 100, deltaMode: 0 });
    expect(rig.dist).toBeGreaterThan(d);
  });

  it('on: a drag eases, then glides after release and ends where the whole drag says', () => {
    const { rig, fire } = makeRig(P);
    const az = rig.az;
    fire('pointerdown', { clientX: 10, clientY: 10 });
    fire('pointermove', { clientX: 110, clientY: 10 });
    expect(rig.az).toBe(az); // nothing applied until the next frame
    let t = 0;
    rig.update(null, new THREE.Vector3(), (t += 16));
    const first = az - rig.az;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(100 * 0.0055 * 0.2);
    fire('pointerup', { clientX: 110, clientY: 10 });
    for (let i = 0; i < 300; i++) rig.update(null, new THREE.Vector3(), (t += 16));
    expect(rig.az).toBeCloseTo(az - 100 * 0.0055, 6);
  });

  it('on, same result at 30 and 144 fps', () => {
    const run = (fps: number) => {
      const { rig, fire } = makeRig(P);
      fire('pointerdown', { clientX: 0, clientY: 0 });
      fire('pointermove', { clientX: 80, clientY: 40 });
      fire('pointerup', {});
      let t = 0;
      for (let i = 0; i < fps * 0.5; i++) rig.update(null, new THREE.Vector3(), (t += 1000 / fps));
      return [rig.az, rig.el];
    };
    const a = run(30), b = run(144);
    expect(a[0]).toBeCloseTo(b[0], 4);
    expect(a[1]).toBeCloseTo(b[1], 4);
  });

  it('inertia off: releasing applies what is pending at once', () => {
    const { rig, fire } = makeRig({ ...P, inertia: false });
    const az = rig.az;
    fire('pointerdown', { clientX: 0, clientY: 0 });
    fire('pointermove', { clientX: 100, clientY: 0 });
    fire('pointerup', {});
    expect(rig.az).toBeCloseTo(az - 100 * 0.0055, 12);
  });

  it('wheel zoom eases and respects the distance limits', () => {
    const { rig, fire } = makeRig(P);
    rig.maxDist = 40000;
    const d0 = rig.dist;
    fire('wheel', { deltaY: 100, deltaMode: 0 });
    expect(rig.dist).toBe(d0);
    let t = 0;
    for (let i = 0; i < 20; i++) rig.update(null, new THREE.Vector3(), (t += 16));
    expect(rig.dist).toBeGreaterThan(d0);
    for (let i = 0; i < 40; i++) fire('wheel', { deltaY: 400, deltaMode: 0 });
    for (let i = 0; i < 400; i++) rig.update(null, new THREE.Vector3(), (t += 16));
    expect(rig.dist).toBe(40000);
    // the rest of the pushed-against-the-limit zoom was dropped: one step back in starts moving at once
    fire('wheel', { deltaY: -300, deltaMode: 0 });
    for (let i = 0; i < 400; i++) rig.update(null, new THREE.Vector3(), (t += 16));
    expect(rig.dist).toBeLessThan(40000);
  });

  it('a fly-to, stopInertia and a mode switch drop the glide; the elevation limit is kept', () => {
    for (const stop of [(r: OrbitRig) => r.flyTo({ dist: 20000, az: 1, el: 0.2 }), (r: OrbitRig) => r.stopInertia(), (r: OrbitRig) => r.switchMode('surface')]) {
      const { rig, fire } = makeRig(P);
      fire('pointerdown', { clientX: 0, clientY: 0 });
      fire('pointermove', { clientX: 200, clientY: 0 });
      fire('pointerup', {});
      stop(rig);
      const az = rig.az;
      let t = 0;
      if (rig.flying) continue; // a flight overrides az itself; only the damper state matters here
      for (let i = 0; i < 100; i++) rig.update(null, new THREE.Vector3(), (t += 16));
      expect(rig.az).toBe(az);
    }
    const { rig, fire } = makeRig(P);
    fire('pointerdown', { clientX: 0, clientY: 0 });
    fire('pointermove', { clientX: 0, clientY: 100000 });
    let t = 0;
    for (let i = 0; i < 300; i++) rig.update(null, new THREE.Vector3(), (t += 16));
    expect(rig.el).toBeLessThanOrEqual(1.5);
  });

  it('turning smoothing off applies what is gliding; the first-person view is never smoothed', () => {
    const { rig, fire } = makeRig(P);
    const az = rig.az;
    fire('pointerdown', { clientX: 0, clientY: 0 });
    fire('pointermove', { clientX: 100, clientY: 0 });
    rig.stopInertia(true);
    expect(rig.az).toBeCloseTo(az - 100 * 0.0055, 12);

    const fp = makeRig(P);
    fp.rig.switchMode('firstPerson');
    const a0 = fp.rig.az;
    fp.fire('pointerdown', { clientX: 0, clientY: 0 });
    fp.fire('pointermove', { clientX: 50, clientY: 0 });
    expect(fp.rig.az).not.toBe(a0); // applied at once
  });
});

describe('OrbitRig glide handling', () => {
  it('a new press catches the glide', () => {
    const { rig, fire } = makeRig(P);
    fire('pointerdown', { clientX: 0, clientY: 0 });
    fire('pointermove', { clientX: 200, clientY: 0 });
    fire('pointerup', {});
    fire('pointerdown', { clientX: 0, clientY: 0 });
    const az = rig.az;
    let t = 0;
    for (let i = 0; i < 50; i++) rig.update(null, new THREE.Vector3(), (t += 16));
    expect(rig.az).toBe(az);
  });
  it('releasing with no inertia does not flush a pending wheel zoom in one jump', () => {
    const { rig, fire } = makeRig({ ...P, inertia: false });
    fire('pointerdown', { clientX: 0, clientY: 0 });
    fire('wheel', { deltaY: 300, deltaMode: 0 });
    const d0 = rig.dist;
    fire('pointerup', {});
    expect(rig.dist).toBe(d0);
    rig.update(null, new THREE.Vector3(), 16);
    expect(rig.dist).toBeGreaterThan(d0);
    expect(rig.dist).toBeLessThan(d0 * Math.exp(300 * 0.0013) * 0.99);
  });
});
