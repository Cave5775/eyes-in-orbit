import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ISS_CHANNELS, sunDirectionEci, type IssArrays } from '@eio/core';
import { lvlhBasis } from '../src/lib/attitude';
import {
  IssArrayTracker, LIVE_MAX_AGE_MS, alphaToSarjLiveDeg, angleDiffDeg, arrayReadout, arraySources, issJoints, sarjLiveToAlphaDeg, sourceLabel,
  sunInBody, sunInBodyFromState, sunTrackingAngles, wrap360,
} from '../src/lib/arrays';
import type { V3 } from '../src/lib/camera';
import recordedJson from '../../server/test/fixtures/iss-live-recorded.json';

const DEG = Math.PI / 180;
const unit = (a: V3): V3 => {
  const n = Math.hypot(...a);
  return [a[0] / n, a[1] / n, a[2] / n];
};

describe('sun tracking in the model hierarchy', () => {
  // world normal of a wing's cell side = Ry(alpha) * Rz(gamma) * (1, 0, 0): the SARJ node holds the BGA node
  const normal = (alpha: number, gamma: number): V3 => {
    const v = new THREE.Vector3(1, 0, 0)
      .applyMatrix4(new THREE.Matrix4().makeRotationZ(gamma))
      .applyMatrix4(new THREE.Matrix4().makeRotationY(alpha));
    return [v.x, v.y, v.z];
  };
  const longAxis = (alpha: number): V3 => {
    const v = new THREE.Vector3(0, 0, 1).applyMatrix4(new THREE.Matrix4().makeRotationY(alpha));
    return [v.x, v.y, v.z];
  };

  it('points the cell-side normal at the Sun for any sun direction (the long axis stays perpendicular to the sun projection)', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    for (let i = 0; i < 200; i++) {
      const s = unit([rnd(), rnd() * 0.6, rnd()]);
      const { alpha, gamma } = sunTrackingAngles(s);
      const n = normal(alpha, gamma);
      expect(n[0] * s[0] + n[1] * s[1] + n[2] * s[2]).toBeCloseTo(1, 9);
      const u = longAxis(alpha);
      expect(u[0] * s[0] + u[2] * s[2]).toBeCloseTo(0, 9); // BGA axis is perpendicular to the in-plane sun component
    }
  });

  it('turns once per orbit as the sun moves around the LVLH frame, and gamma is the beta tilt', () => {
    // sun in the orbit plane rotating about +Y (the body frame turns the other way)
    let prev = sunTrackingAngles([1, 0, 0]).alpha;
    let total = 0;
    for (let k = 1; k <= 360; k++) {
      const a = k * DEG;
      const s: V3 = [Math.cos(a), 0, -Math.sin(a)]; // as seen from the orbiting body: rotates -> alpha grows
      const t = sunTrackingAngles(s);
      total += angleDiffDeg((t.alpha / DEG), prev / DEG);
      prev = t.alpha;
      expect(t.gamma).toBeCloseTo(0, 12);
    }
    expect(Math.abs(total)).toBeCloseTo(360, 6);
    expect(sunTrackingAngles(unit([0.5, 0.5, 0.5])).gamma / DEG).toBeCloseTo(Math.asin(0.5 / Math.hypot(0.5, 0.5, 0.5)) / DEG, 9);
  });
});

describe('SARJ live conversion', () => {
  it('maps feed readings to the model angle and back; the sides are mirrored', () => {
    expect(sarjLiveToAlphaDeg('starboard', 0)).toBe(90);
    expect(sarjLiveToAlphaDeg('starboard', 300)).toBe(30);
    expect(sarjLiveToAlphaDeg('port', 0)).toBe(90);
    expect(sarjLiveToAlphaDeg('port', 100)).toBe(350);
    for (const live of [0, 17.25, 92.4, 267.6, 359.9]) {
      for (const side of ['port', 'starboard'] as const) {
        expect(alphaToSarjLiveDeg(side, sarjLiveToAlphaDeg(side, live))).toBeCloseTo(live, 9);
      }
    }
    // the same model angle gives mirrored readings: they sum to 0 (mod 360), like the real 92.4 + 267.6
    expect(wrap360(alphaToSarjLiveDeg('starboard', 200) + alphaToSarjLiveDeg('port', 200) - 0)).toBeCloseTo(0 + 0, 9);
  });

  it('wraps angles', () => {
    expect(wrap360(-10)).toBe(350);
    expect(wrap360(725)).toBe(5);
    expect(angleDiffDeg(1, 359)).toBe(2);
    expect(angleDiffDeg(359, 1)).toBe(-2);
  });
});

interface Snap {
  isoTime: string;
  items: Record<string, { hours: number; value: number }>;
}
const recorded = recordedJson as { snapshots: Snap[] };

describe('against recorded ISSLIVE data', () => {
  // Three snapshots, two minutes apart, recorded 2026-10-22 (ISS state J2000, attitude quaternion, SARJ readings).
  for (const snap of recorded.snapshots) {
    const im = snap.items;
    const t = Date.parse(snap.isoTime);
    const r: V3 = [im.USLAB000032.value, im.USLAB000033.value, im.USLAB000034.value];
    const v: V3 = [im.USLAB000035.value / 1000, im.USLAB000036.value / 1000, im.USLAB000037.value / 1000];
    const q = [im.USLAB000018.value, im.USLAB000019.value, im.USLAB000020.value, im.USLAB000021.value];
    const sun = sunDirectionEci(t);

    it(`${snap.isoTime}: SARJ readings equal the computed sun-tracking angle once the live attitude is applied`, () => {
      const body = sunInBodyFromState(r, v, sun, q)!;
      const alpha = sunTrackingAngles(body).alpha / DEG;
      expect(Math.abs(angleDiffDeg(alphaToSarjLiveDeg('starboard', alpha), im.S0000003.value))).toBeLessThan(0.5);
      expect(Math.abs(angleDiffDeg(alphaToSarjLiveDeg('port', alpha), im.S0000004.value))).toBeLessThan(0.5);
    });

    it(`${snap.isoTime}: without the attitude the flight-attitude (LVLH) estimate is off by the ISS pitch bias`, () => {
      const alpha = sunTrackingAngles(sunInBodyFromState(r, v, sun)!).alpha / DEG;
      const err = Math.abs(angleDiffDeg(alphaToSarjLiveDeg('starboard', alpha), im.S0000003.value));
      expect(err).toBeGreaterThan(5);
      expect(err).toBeLessThan(10);
    });

    it(`${snap.isoTime}: the SARJ pair sums to 360 and the quaternion is a unit quaternion`, () => {
      expect(wrap360(im.S0000003.value + im.S0000004.value)).toBeCloseTo(0, 0);
      expect(Math.hypot(...q)).toBeCloseTo(1, 4);
      const lvlh = lvlhBasis(r, v)!;
      expect(sunInBody(lvlh, sun, q)).not.toEqual(sunInBody(lvlh, sun));
    });
  }

  it('SARJ advances at the orbital rate between snapshots', () => {
    const [a, b] = [recorded.snapshots[0], recorded.snapshots[2]];
    const dt = (b.items.S0000003.hours - a.items.S0000003.hours) * 3600;
    const rate = angleDiffDeg(b.items.S0000003.value, a.items.S0000003.value) / dt;
    expect(rate).toBeGreaterThan(0.0630);
    expect(rate).toBeLessThan(0.0665);
  });
});

describe('array sources', () => {
  const now = 1_000_000_000_000;
  const arrays = (over: Partial<IssArrays> = {}): IssArrays => ({
    t: now - 2000, sarj: { port: 267.6, starboard: 92.4 }, bga: { '2A': 43 }, attitude: [1, 0, 0, 0],
    verified: { sarj: true, bga: false, attitude: true }, ...over,
  });
  const ctx = { liveClock: true, nowMs: now, haveState: true };

  it('LIVE for fresh verified SARJ at live time, COMPUTED for unverified BGA', () => {
    const s = arraySources(arrays(), ctx);
    expect(s).toEqual({ sarj: 'LIVE', bga: 'COMPUTED', attitude: true });
    expect(sourceLabel(s)).toBe('SARJ LIVE / BGA COMPUTED');
    expect(arraySources(arrays({ verified: { sarj: true, bga: true, attitude: true } }), ctx).bga).toBe('LIVE');
    expect(sourceLabel({ sarj: 'LIVE', bga: 'LIVE', attitude: true })).toBe('LIVE');
  });

  it('falls back to COMPUTED when the feed is missing, stale, unverified, or the clock is not live', () => {
    expect(arraySources(undefined, ctx)).toEqual({ sarj: 'COMPUTED', bga: 'COMPUTED', attitude: false });
    expect(arraySources(arrays({ t: now - LIVE_MAX_AGE_MS - 1 }), ctx).sarj).toBe('COMPUTED');
    expect(arraySources(arrays({ verified: { sarj: false, bga: false, attitude: false } }), ctx)).toEqual({ sarj: 'COMPUTED', bga: 'COMPUTED', attitude: false });
    expect(arraySources(arrays(), { ...ctx, liveClock: false }).sarj).toBe('COMPUTED');
    expect(arraySources(arrays({ sarj: {} }), ctx).sarj).toBe('COMPUTED');
  });

  it('is STATIC when there is no state to compute from', () => {
    expect(arraySources(undefined, { ...ctx, haveState: false })).toEqual({ sarj: 'STATIC', bga: 'STATIC', attitude: false });
    expect(sourceLabel({ sarj: 'STATIC', bga: 'STATIC', attitude: false })).toBe('STATIC');
  });
});

describe('issJoints', () => {
  const sun: V3 = unit([0.6, 0.2, -0.5]);
  const t = sunTrackingAngles(sun);

  it('computed: both sides and all eight wings take the sun-tracking angles', () => {
    const j = issJoints({ sunBody: sun, sources: { sarj: 'COMPUTED', bga: 'COMPUTED', attitude: false } });
    expect(j['sarj.port']).toBeCloseTo(t.alpha, 12);
    expect(j['sarj.stbd']).toBeCloseTo(t.alpha, 12);
    for (const c of ISS_CHANNELS) expect(j[`bga.${c}`]).toBeCloseTo(t.gamma, 12);
    expect(Object.keys(j)).toHaveLength(10);
  });

  it('live SARJ overrides the computed angle per side; BGA stays computed while unverified', () => {
    const j = issJoints({ sunBody: sun, sarjLive: { port: 267.6, starboard: 92.4 }, sources: { sarj: 'LIVE', bga: 'COMPUTED', attitude: true } });
    expect(j['sarj.stbd'] / DEG).toBeCloseTo(182.4, 6);
    expect(wrap360(j['sarj.port'] / DEG)).toBeCloseTo(182.4, 6); // 90 - 267.6 = -177.6 = 182.4
    expect(j['bga.2A']).toBeCloseTo(t.gamma, 12);
  });

  it('static: all joints at zero', () => {
    const j = issJoints({ sunBody: null, sources: { sarj: 'STATIC', bga: 'STATIC', attitude: false } });
    expect(Object.values(j).every((x) => x === 0)).toBe(true);
  });
});

describe('arrayReadout', () => {
  const sun: V3 = unit([0.6, 0.2, -0.5]);
  it('shows live SARJ and raw BGA values where the feed has them, computed values elsewhere', () => {
    const arrays: IssArrays = { t: 1, sarj: { port: 267.6, starboard: 92.4 }, bga: { '2A': 43 }, verified: { sarj: true, bga: false, attitude: true } };
    const r = arrayReadout(arrays, sun, { sarj: 'LIVE', bga: 'COMPUTED', attitude: false });
    expect(r.sarj).toEqual({ port: 267.6, starboard: 92.4 });
    expect(r.bga['2A']).toEqual({ deg: 43, computed: false });
    expect(r.bga['4A']!.computed).toBe(true);
    expect(r.bga['4A']!.deg).toBeCloseTo(Math.asin(0.2 / Math.hypot(0.6, 0.2, 0.5)) / DEG, 9);
  });
  it('computed SARJ readings are mirrored in the feed convention', () => {
    const r = arrayReadout(undefined, sun, { sarj: 'COMPUTED', bga: 'COMPUTED', attitude: false });
    expect(wrap360(r.sarj.port! + r.sarj.starboard!)).toBeCloseTo(0, 9);
  });
});

describe('IssArrayTracker', () => {
  const mk = (t: number, stbd: number): IssArrays => ({ t, sarj: { starboard: stbd, port: wrap360(-stbd) }, bga: {}, verified: { sarj: true, bga: false, attitude: false } });

  it('returns the sample until it has a rate, then extrapolates at that rate for at most 3 s', () => {
    const tr = new IssArrayTracker();
    tr.push(mk(1000, 90), 5000);
    expect(tr.sarjDeg('starboard', 5500)).toBe(90);
    tr.push(mk(2000, 90.0645), 6000);
    expect(tr.sarjDeg('starboard', 6000)).toBeCloseTo(90.0645, 6);
    expect(tr.sarjDeg('starboard', 6500)).toBeCloseTo(90.0645 + 0.0645 * 0.5, 6);
    expect(tr.sarjDeg('starboard', 60_000)).toBeCloseTo(90.0645 + 0.0645 * 3, 6); // capped
    expect(tr.sarjDeg('port', 6500)! - wrap360(-90.0645)).toBeCloseTo(-0.0645 * 0.5, 6); // port runs the other way
  });

  it('is continuous across the 360 wrap and ignores repeated messages', () => {
    const tr = new IssArrayTracker();
    tr.push(mk(1000, 359.98), 0);
    tr.push(mk(2000, 0.04), 1000);
    expect(tr.sarjDeg('starboard', 1500)).toBeCloseTo(0.04 + 0.06 * 0.5, 6);
    tr.push(mk(2000, 0.04), 1200);
    expect(tr.sarjDeg('starboard', 1500)).toBeCloseTo(0.04 + 0.06 * 0.5, 6); // the elapsed time still counts from the first receipt
  });

  it('caps the extrapolation rate and clears on undefined', () => {
    const tr = new IssArrayTracker();
    tr.push(mk(1000, 10), 0);
    tr.push(mk(1100, 100), 100);
    expect(tr.sarjDeg('starboard', 1100)).toBeCloseTo(100 + 0.3, 6);
    tr.push(undefined, 2000);
    expect(tr.arrays).toBeUndefined();
    expect(tr.sarjDeg('starboard', 2000)).toBeUndefined();
  });
});
