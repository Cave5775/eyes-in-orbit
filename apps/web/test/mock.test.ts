import { describe, expect, it } from 'vitest';
import { EARTH, EntityGraph, Sgp4Provider, norm, providerFromSpec, type EntityRecord } from '@eio/core';
import {
  makeOmm, mockDsn, mockGroundAndProbes, mockIssFix, mockLaunches, mockNews, mockSatellites, mulberry32,
} from '../src/mock/generators';
import { computeTelemetry } from '../src/lib/telemetry';
import { orbitPeriodSec } from '../src/lib/orbit';

const NOW = Date.parse('2026-10-22T12:00:00Z');

describe('mock catalog', () => {
  const sats = mockSatellites(NOW);

  it('is deterministic and has the requested size with unique ids', () => {
    expect(sats).toHaveLength(2000);
    expect(new Set(sats.map((s) => s.id)).size).toBe(2000);
    expect(mockSatellites(NOW, 50, 7).map((s) => s.id)).toEqual(mockSatellites(NOW, 50, 7).map((s) => s.id));
    const rnd = mulberry32(1);
    expect(rnd()).toBeGreaterThanOrEqual(0);
    expect(rnd()).toBeLessThan(1);
  });

  it('follows the entity conventions of the contract', () => {
    const iss = sats.find((s) => s.id === 'sat-25544')!;
    expect(iss.kind).toBe('station');
    expect(iss.render).toMatchObject({ colorKey: 'station', footprint: true, orbitLine: true, trailSeconds: 5400 });
    expect(iss.links?.streams?.length).toBeGreaterThan(0);
    const kinds = new Set(sats.map((s) => s.kind));
    expect([...kinds].sort()).toEqual(['debris', 'satellite', 'station']);
    expect(new Set(sats.map((s) => s.group))).toEqual(new Set(['stations', 'active', 'starlink']));
    for (const s of sats) {
      expect(s.provider?.type).toBe('sgp4');
      expect(s.aliases.norad).toBe(s.id.slice(4));
    }
  });

  it('produces OMM that Sgp4Provider propagates to plausible Earth-orbit states', () => {
    let failures = 0;
    for (const s of sats) {
      if (s.provider?.type !== 'sgp4') throw new Error('expected sgp4');
      const st = new Sgp4Provider(s.provider.omm).stateAt(NOW);
      if (!st) { failures++; continue; }
      const r = norm(st.r);
      expect(r).toBeGreaterThan(EARTH.radiusKm + 150);
      expect(r).toBeLessThan(70_000);
      expect(st.confidence).toBe(1);
    }
    expect(failures).toBe(0);
  });

  it('ISS orbit has the right altitude and period', () => {
    const iss = sats.find((s) => s.id === 'sat-25544')!;
    const g = new EntityGraph();
    g.upsert(iss);
    const st = g.stateOf(iss.id, NOW)!;
    const alt = norm(st.r) - EARTH.radiusKm;
    expect(alt).toBeGreaterThan(300);
    expect(alt).toBeLessThan(500);
    expect(orbitPeriodSec(g, iss, st)! / 60).toBeCloseTo(92.9, 0);
    const tel = computeTelemetry(g, iss, NOW)!;
    expect(tel.speedKmS).toBeGreaterThan(7.4);
    expect(tel.speedKmS).toBeLessThan(7.9);
    expect(tel.latDeg!).toBeLessThanOrEqual(51.7);
    expect(tel.shell).toBe(false);
  });

  it('makeOmm normalises angles and formats the epoch', () => {
    const omm = makeOmm({ name: 'T', norad: 1, epochMs: NOW, meanMotion: 15, ecc: 0.001, incl: 10, raan: -10, argp: 370, ma: 0 });
    expect(omm.RA_OF_ASC_NODE).toBe(350);
    expect(omm.ARG_OF_PERICENTER).toBe(10);
    expect(Date.parse(`${omm.EPOCH}Z`)).toBe(NOW);
  });
});

describe('mock non-SGP4 entities', () => {
  const entities = [...mockLaunches(NOW).entities, ...mockGroundAndProbes(NOW)];

  it('every provider spec rebuilds and resolves a state at "now"', () => {
    const g = new EntityGraph();
    entities.forEach((e) => g.upsert(e));
    for (const e of entities) {
      expect(providerFromSpec(e.provider!)).toBeDefined();
      expect(g.stateIn(e.id, NOW, 'EARTH:inertial'), e.id).not.toBeNull();
    }
  });

  it('puts probes beyond the shell threshold except JWST', () => {
    const g = new EntityGraph();
    entities.forEach((e) => g.upsert(e));
    const range = (id: string) => norm(g.stateIn(id, NOW, 'EARTH:inertial')!.r);
    expect(range('dsn-VGR1')).toBeGreaterThan(1e10);
    expect(range('dsn-JWST')).toBeLessThan(2e6);
    expect(range('dsn-MRO')).toBeGreaterThan(5e7);
    expect(range('demo-rover')).toBeGreaterThan(5e7);
  });

  it('launches are NET-ordered with consistent entities and phases', () => {
    const { launches, entities: ents } = mockLaunches(NOW);
    const nets = launches.map((l) => Date.parse(l.net));
    expect([...nets].sort((a, b) => a - b)).toEqual(nets);
    const byId = new Map<string, EntityRecord>(ents.map((e) => [e.id, e]));
    for (const l of launches) {
      expect(byId.get(l.entityId)?.links?.launchId).toBe(l.id);
      expect(l.pad).toBeDefined();
    }
    expect(launches.some((l) => l.phase === 'COUNTDOWN')).toBe(true);
    expect(launches.some((l) => l.phase === 'ON_ORBIT')).toBe(true);
  });

  it('news, DSN and ISS fix are well-formed', () => {
    expect(mockNews(NOW).length).toBeGreaterThan(5);
    expect(mockNews(NOW, 'voyager').every((a) => /voyager/i.test(a.title))).toBe(true);
    expect(mockDsn(NOW).links.some((l) => l.downlink?.active)).toBe(true);
    const iss = mockSatellites(NOW, 5).find((s) => s.id === 'sat-25544')!;
    if (iss.provider?.type !== 'sgp4') throw new Error('expected sgp4');
    const fix = mockIssFix(iss.provider.omm, NOW)!;
    expect(Math.abs(fix.latitude)).toBeLessThanOrEqual(51.7);
    expect(fix.velocityKmh).toBeGreaterThan(26_000);
    expect(['daylight', 'eclipsed']).toContain(fix.visibility);
  });
});
