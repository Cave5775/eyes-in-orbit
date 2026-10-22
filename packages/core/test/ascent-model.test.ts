import { describe, expect, it } from 'vitest';
import {
  CompositeProvider, DEG, EARTH, defaultInclination, groundAzimuthDeg, inclinationForAzimuthDeg, inertialAzimuthDeg,
  modelFalcon9Ascent, modeledAscentForLaunch, modeledAscentSegments, pchip, providerFromSpec, sampleAscentRows,
  secoSpeedKmS, stateToGeodetic, ascentEntityEvents, ascentPhaseAt, defaultBranch,
  type Launch,
} from '../src';

const VSFB = { padLatDeg: 34.632, padLonDeg: -120.611 };
const CAPE = { padLatDeg: 28.5618, padLonDeg: -80.5772 };

const vsfb = () => modelFalcon9Ascent({ ...VSFB, inclinationDeg: 70, branch: 'south' });
const cape = () => modelFalcon9Ascent({ ...CAPE, inclinationDeg: 53, branch: 'north' });

describe('launch azimuth', () => {
  it('matches sin(Az) = cos(i)/cos(lat) and the textbook Cape values', () => {
    // 51.6 deg from the Cape: ~45 deg (the classic ISS azimuth)
    expect(inertialAzimuthDeg(51.6, 28.5, 'north')).toBeCloseTo(45, 0);
    // due east when the inclination equals the pad latitude
    expect(inertialAzimuthDeg(28.5, 28.5, 'north')).toBeCloseTo(90, 6);
    // equatorial launch to a polar orbit goes due north
    expect(inertialAzimuthDeg(90, 0, 'north')).toBeCloseTo(0, 6);
    expect(inertialAzimuthDeg(90, 0, 'south')).toBeCloseTo(180, 6);
  });

  it('Vandenberg to 70 deg: south-east branch mirrors the north-east one', () => {
    const ne = inertialAzimuthDeg(70, 34.632, 'north');
    const se = inertialAzimuthDeg(70, 34.632, 'south');
    expect(ne).toBeCloseTo(24.5, 0);
    expect(se).toBeCloseTo(180 - ne, 9);
  });

  it('retrograde (sun-synchronous) orbits head south of west-to-east', () => {
    const az = inertialAzimuthDeg(97.4, 34.632, 'south');
    expect(az).toBeGreaterThan(180);
    expect(az).toBeLessThan(200);
    expect(inertialAzimuthDeg(97.4, 34.632, 'north')).toBeGreaterThan(340);
  });

  it('round-trips azimuth <-> inclination and clamps unreachable inclinations', () => {
    const az = inertialAzimuthDeg(53, 28.5, 'north');
    expect(inclinationForAzimuthDeg(az, 28.5)).toBeCloseTo(53, 6);
    expect(inertialAzimuthDeg(10, 28.5, 'north')).toBeCloseTo(90, 6);
  });

  it('Earth rotation bends the ground track away from the inertial heading', () => {
    // a south-east launch (155 deg inertial) is flown at a more southerly ground azimuth
    expect(groundAzimuthDeg(155.5, 34.632)).toBeGreaterThan(155.5);
    // a north-east launch gets a more northerly one
    expect(groundAzimuthDeg(45, 28.5)).toBeLessThan(45);
  });

  it('west coast pads fly south, the Cape flies north-east', () => {
    expect(defaultBranch(34.632, -120.611)).toBe('south');
    expect(defaultBranch(28.5, -80.6)).toBe('north');
  });
});

describe('inclination defaults', () => {
  const base = { padLatDeg: 34.632, padLonDeg: -120.611 };
  it('uses the Starlink group table (group 15 is the 70 deg shell)', () => {
    expect(defaultInclination({ ...base, name: 'Falcon 9 Block 5 | Starlink Group 15-15', missionName: 'Starlink Group 15-15' }))
      .toEqual({ deg: 70, source: 'starlink-group' });
  });
  it('prefers an inclination stated in the description', () => {
    expect(defaultInclination({ ...base, name: 'x', description: 'Deployed to a 97.6 degrees inclination orbit' }).deg).toBe(97.6);
    expect(defaultInclination({ ...base, name: 'x', description: 'orbit with inclination of 53.2°' }).deg).toBe(53.2);
  });
  it('falls back per orbit class and site', () => {
    expect(defaultInclination({ ...base, name: 'Transporter', orbit: 'Sun-Synchronous Orbit' }).deg).toBe(97.4);
    expect(defaultInclination({ padLatDeg: 28.5, padLonDeg: -80.6, name: 'Crew-14' }).deg).toBe(51.6);
    expect(defaultInclination({ padLatDeg: 28.5, padLonDeg: -80.6, name: 'Starlink Group 99-1' })).toEqual({ deg: 53.2, source: 'site-default' });
    expect(defaultInclination({ padLatDeg: 28.5, padLonDeg: -80.6, name: 'Sat', orbit: 'Geostationary Transfer Orbit' }).source).toBe('orbit');
  });
});

describe('pchip', () => {
  it('is monotone through monotone data and hits the knots', () => {
    const f = pchip([0, 1, 2, 10], [0, 1, 1.1, 9]);
    expect(f(1)).toBeCloseTo(1, 12);
    let prev = -1;
    for (let x = 0; x <= 10; x += 0.05) {
      const y = f(x);
      expect(y).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = y;
    }
  });
});

describe('modeled Falcon 9 ascent', () => {
  it.each([['Vandenberg 70 deg', vsfb], ['Cape 53 deg', cape]])('%s: altitude, speed and downrange never decrease', (_n, make) => {
    const { rows, timeline } = make();
    expect(rows[0]).toMatchObject({ tSec: 0, altKm: 0, speedKmS: 0, downrangeKm: 0 });
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].tSec).toBeGreaterThan(rows[i - 1].tSec);
      expect(rows[i].altKm).toBeGreaterThanOrEqual(rows[i - 1].altKm - 1e-9);
      expect(rows[i].downrangeKm).toBeGreaterThanOrEqual(rows[i - 1].downrangeKm);
      // speed rises through the burns; the only dip is the tiny gravity loss over the MECO -> SES coast
      const coasting = rows[i].tSec > timeline.mecoSec && rows[i].tSec <= timeline.mecoSec + timeline.sesDelaySec;
      if (!coasting) expect(rows[i].speedKmS).toBeGreaterThanOrEqual(rows[i - 1].speedKmS - 1e-9);
    }
  });

  it('has sensible MECO, max-Q and SECO states', () => {
    for (const m of [vsfb(), cape()]) {
      const ev = Object.fromEntries(m.events.map((e) => [e.name, e]));
      expect(ev.MAX_Q.tSec).toBeGreaterThan(60);
      expect(ev.MAX_Q.tSec).toBeLessThan(80);
      expect(ev.MAX_Q.altKm).toBeGreaterThan(9);
      expect(ev.MAX_Q.altKm).toBeLessThan(15);
      expect(ev.MECO.tSec).toBeGreaterThan(140);
      expect(ev.MECO.tSec).toBeLessThan(160);
      expect(ev.MECO.altKm).toBeGreaterThan(65);
      expect(ev.MECO.altKm).toBeLessThan(80);
      expect(ev.MECO.speedKmS).toBeGreaterThan(2.2);
      expect(ev.MECO.speedKmS).toBeLessThan(2.5);
      expect(ev.SECO.tSec).toBeGreaterThan(500);
      expect(ev.SECO.tSec).toBeLessThan(520);
      // Earth-relative speed near orbital (7.6 km/s) and a low-Earth-orbit altitude
      expect(ev.SECO.speedKmS).toBeGreaterThan(7.4);
      expect(ev.SECO.speedKmS).toBeLessThan(7.8);
      expect(ev.SECO.altKm).toBeGreaterThan(150);
      expect(ev.SECO.altKm).toBeLessThan(250);
      // ordering of the event chain
      const order = ['LIFTOFF', 'MAX_Q', 'MECO', 'STAGE_SEP', 'SES', 'FAIRING_SEP', 'SECO'].map((n) => ev[n].tSec);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    }
  });

  it('puts the booster landing between T+7:45 and T+8:30 (droneship) and earlier for RTLS', () => {
    const ship = vsfb();
    const land = ship.events.find((e) => e.name === 'LANDING')!;
    expect(land.track).toBe('booster');
    expect(land.tSec).toBeGreaterThanOrEqual(465);
    expect(land.tSec).toBeLessThanOrEqual(510);
    expect(ship.events.some((e) => e.name === 'BOOSTBACK')).toBe(false);
    const rtls = modelFalcon9Ascent({ ...CAPE, inclinationDeg: 51.6, recovery: 'rtls' });
    expect(rtls.events.find((e) => e.name === 'LANDING')!.tSec).toBeLessThan(land.tSec);
    expect(rtls.events.some((e) => e.name === 'BOOSTBACK')).toBe(true);
    expect(modelFalcon9Ascent({ ...CAPE, inclinationDeg: 51.6, recovery: 'none' }).events.some((e) => e.track === 'booster')).toBe(false);
  });

  it('downrange at SECO is on the order of 1,000-2,500 km', () => {
    const m = vsfb();
    const seco = sampleAscentRows(m.rows, m.timeline.secoSec)!;
    expect(seco.downrangeKm).toBeGreaterThan(1000);
    expect(seco.downrangeKm).toBeLessThan(2500);
  });

  it('derives the azimuth from inclination and pad latitude', () => {
    const m = vsfb();
    expect(m.inertialAzimuthDeg).toBeCloseTo(inertialAzimuthDeg(70, VSFB.padLatDeg, 'south'), 9);
    expect(m.azimuthDeg).toBeGreaterThan(m.inertialAzimuthDeg);
    expect(m.azimuthDeg).toBeLessThan(180);
    expect(cape().azimuthDeg).toBeGreaterThan(30);
    expect(cape().azimuthDeg).toBeLessThan(60);
  });

  it('SECO speed follows the Earth rotation along the azimuth', () => {
    const tl = vsfb().timeline;
    const fast = secoSpeedKmS(tl, 28.5, 90); // due east: rotation helps most
    const slow = secoSpeedKmS(tl, 28.5, 270); // due west: rotation hurts
    expect(slow - fast).toBeGreaterThan(0.7);
  });

  it('is memoised and phases tile the timeline', () => {
    expect(vsfb()).toBe(vsfb());
    const m = vsfb();
    expect(m.phases[0].fromSec).toBe(0);
    for (let i = 1; i < m.phases.length; i++) expect(m.phases[i].fromSec).toBe(m.phases[i - 1].toSec);
    expect(ascentPhaseAt(m.phases, 100)!.id).toBe('first-stage');
    expect(ascentPhaseAt(m.phases, 154)!.id).toBe('staging');
    expect(ascentPhaseAt(m.phases, 300)!.id).toBe('second-stage');
    expect(ascentPhaseAt(m.phases, 700)!.id).toBe('orbit-coast');
    expect(ascentPhaseAt(m.phases, -5)).toBeUndefined();
  });

  it('exposes absolute entity events', () => {
    const ev = ascentEntityEvents(vsfb().events, 1_000_000);
    const meco = ev.find((e) => e.name === 'MECO')!;
    expect(meco.tMs).toBe(1_000_000 + 150_000);
    expect(meco.detail).toContain('MODELED');
  });

  it('rejects an inconsistent timeline', () => {
    expect(() => modelFalcon9Ascent({ ...CAPE, inclinationDeg: 53, timeline: { secoSec: 100 } })).toThrow();
  });
});

describe('modeled composite provider', () => {
  it('holds the pad until NET, then follows the ascent along the azimuth with phase labels', () => {
    const m = vsfb();
    const net = Date.parse('2026-10-22T22:51:18Z');
    const segs = modeledAscentSegments(net, { latDeg: VSFB.padLatDeg, lonDeg: VSFB.padLonDeg }, m);
    expect(segs.map((s) => s.phase)).toEqual(['pad', 'stage 1 ascent', 'staging', 'stage 2 burn', 'orbit (held)', 'pad (launch complete)']);
    const p = providerFromSpec({ type: 'composite', segments: segs }) as CompositeProvider;
    expect(p.segmentAt(net - 1000)!.phase).toBe('pad');
    expect(p.segmentAt(net + 60_000)!.phase).toBe('stage 1 ascent');
    expect(p.segmentAt(net + 300_000)!.phase).toBe('stage 2 burn');

    // every instant from -10 s to the end of the hold has a state, with no gaps at segment joins
    for (let t = -10; t <= 1110; t += 0.5) expect(p.stateAt(net + t * 1000), `t=${t}`).not.toBeNull();
    expect(p.segmentAt(net + 1200_000)!.phase).toBe('pad (launch complete)');

    const g = (t: number) => stateToGeodetic(p.stateAt(net + t * 1000)!, net + t * 1000, 'EARTH');
    expect(g(-5).lat / DEG).toBeCloseTo(VSFB.padLatDeg, 4);
    const meco = sampleAscentRows(m.rows, 150)!;
    expect(g(150).alt).toBeCloseTo(meco.altKm, 1);
    // south-east of the pad, and the ground distance matches the integrated downrange
    const end = g(510);
    expect(end.lat / DEG).toBeLessThan(VSFB.padLatDeg);
    expect(end.lon / DEG).toBeGreaterThan(VSFB.padLonDeg);
    const dLat = (end.lat / DEG - VSFB.padLatDeg) * DEG;
    const dLon = (end.lon / DEG - VSFB.padLonDeg) * DEG * Math.cos(VSFB.padLatDeg * DEG);
    expect(Math.hypot(dLat, dLon) * EARTH.radiusKm).toBeGreaterThan(sampleAscentRows(m.rows, 510)!.downrangeKm * 0.9);
  });
});

describe('launch mapping', () => {
  const launch = (over: Partial<Launch> = {}): Launch => ({
    id: 'x', name: 'Falcon 9 Block 5 | Starlink Group 15-15', status: { id: 1, name: 'Go', abbrev: 'Go' }, net: '2026-10-22T22:51:18Z',
    vehicle: 'Falcon 9 Block 5', mission: { name: 'Starlink Group 15-15', orbit: 'LEO' },
    pad: { name: 'SLC-4E', latitude: 34.632, longitude: -120.611 }, streams: [], phase: 'SCHEDULED', hold: false, entityId: 'launch-x',
    ...over,
  });

  it('models Starlink Group 15-15 from Vandenberg at 70 deg, southward', () => {
    const m = modeledAscentForLaunch(launch())!;
    expect(m.inclinationDeg).toBe(70);
    expect(m.inclinationSource).toBe('starlink-group');
    expect(m.branch).toBe('south');
    expect(m.azimuthDeg).toBeGreaterThan(150);
    expect(m.azimuthDeg).toBeLessThan(165);
    expect(m.recovery).toBe('droneship');
  });

  it('skips other vehicles, Falcon Heavy and launches without a pad', () => {
    expect(modeledAscentForLaunch(launch({ vehicle: 'Ariane 64', name: 'Ariane 6 | CSO-4' }))).toBeNull();
    expect(modeledAscentForLaunch(launch({ vehicle: 'Falcon Heavy', name: 'Falcon Heavy | USSF-52' }))).toBeNull();
    expect(modeledAscentForLaunch(launch({ pad: undefined }))).toBeNull();
  });

  it('reads the booster recovery plan', () => {
    expect(modeledAscentForLaunch(launch({ landing: { attempt: true, location: 'LZ-4', type: 'RTLS' } }))!.recovery).toBe('rtls');
    expect(modeledAscentForLaunch(launch({ landing: { attempt: false } }))!.recovery).toBe('none');
  });
});
