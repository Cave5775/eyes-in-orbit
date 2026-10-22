import { readFileSync } from 'node:fs';
import { CompositeProvider, providerFromSpec, stateToGeodetic, DEG, LL2_STATUS, type Launch } from '@eio/core';
import { describe, expect, it } from 'vitest';
import { launchEntity, normalizeLaunch, normalizeStreams, streamKind, syncLaunchEntities } from '../src/connectors/launchlibrary';
import { Hub } from '../src/hub';
import { parseTrajectory } from '../src/trajectory';

const raw = () => JSON.parse(readFileSync(new URL('./fixtures/ll2-launch.json', import.meta.url), 'utf8'));
const NET = Date.parse('2026-10-22T22:51:18Z');

describe('launchlibrary normalize', () => {
  it('maps an LL2 detailed launch', () => {
    const l = normalizeLaunch(raw(), NET - 86_400_000);
    expect(l).toMatchObject({
      id: 'f6af629d-39b5-4f86-bc0c-f8776444a858',
      name: 'Falcon 9 Block 5 | Starlink Group 15-15',
      status: { id: 1, abbrev: 'Go' },
      net: '2026-10-22T22:51:18Z',
      provider: 'SpaceX',
      vehicle: 'Falcon 9 Block 5',
      mission: { name: 'Starlink Group 15-15', orbit: 'LEO' },
      phase: 'SCHEDULED',
      hold: false,
      entityId: 'launch-f6af629d-39b5-4f86-bc0c-f8776444a858',
    });
    // pad lat/lon arrive as strings
    expect(l.pad).toMatchObject({ name: 'Space Launch Complex 4E', latitude: 34.632, longitude: -120.611, countryCode: 'USA' });
  });

  it('classifies stream hosts and puts official webcasts first', () => {
    expect(streamKind('https://www.youtube.com/watch?v=x')).toBe('youtube');
    expect(streamKind('https://youtu.be/x')).toBe('youtube');
    expect(streamKind('https://x.com/i/broadcasts/1')).toBe('x');
    expect(streamKind('https://plus.nasa.gov/live')).toBe('nasa-tv');
    expect(streamKind('https://example.com/live')).toBe('web');
    const streams = normalizeStreams(raw(), NET);
    expect(streams.map((s) => s.kind)).toEqual(['x', 'youtube', 'youtube']);
    expect(streams[0].title).toContain('SpaceX');
  });

  it('tolerates vid_urls and plain-string urls', () => {
    const streams = normalizeStreams({ vid_urls: [{ url: 'https://www.youtube.com/watch?v=a', title: 'T' }, 'https://x.com/b'] }, NET);
    expect(streams.map((s) => s.url)).toEqual(['https://www.youtube.com/watch?v=a', 'https://x.com/b']);
    expect(normalizeStreams({}, NET)).toEqual([]);
  });

  it('survives a missing pad / mission', () => {
    const l = normalizeLaunch({ ...raw(), pad: null, mission: null }, NET);
    expect(l.pad).toBeUndefined();
    expect(l.mission).toBeUndefined();
    expect(launchEntity(l).provider).toBeUndefined();
  });
});

describe('launch phase (mission FSM)', () => {
  const phaseAt = (statusId: number, offsetSec: number) =>
    normalizeLaunch({ ...raw(), status: { id: statusId, name: 's', abbrev: 's' } }, NET + offsetSec * 1000).phase;

  it('walks SCHEDULED -> COUNTDOWN -> ACTIVE_ASCENT -> ORBIT_INSERTION', () => {
    expect(phaseAt(LL2_STATUS.GO, -7200)).toBe('SCHEDULED');
    expect(phaseAt(LL2_STATUS.GO, -600)).toBe('COUNTDOWN');
    expect(phaseAt(LL2_STATUS.IN_FLIGHT, 120)).toBe('ACTIVE_ASCENT');
    expect(phaseAt(LL2_STATUS.IN_FLIGHT, 700)).toBe('ORBIT_INSERTION');
    expect(phaseAt(LL2_STATUS.FAILURE, 60)).toBe('FAILED');
  });

  it('syncLaunchEntities re-derives phases and only reports real changes', () => {
    const hub = new Hub(0);
    const l = normalizeLaunch(raw(), NET - 7200_000);
    hub.setLaunches([l]);
    const events: string[] = [];
    hub.on('launches', () => events.push('launches'));

    syncLaunchEntities(hub, NET - 7200_000);
    expect(hub.graph.get(l.entityId)!.phase).toBe('SCHEDULED');
    expect(events).toEqual([]);

    syncLaunchEntities(hub, NET - 300_000);
    expect(hub.launches[0].phase).toBe('COUNTDOWN');
    expect(hub.graph.get(l.entityId)!.phase).toBe('COUNTDOWN');
    expect(events).toEqual(['launches']);

    // same phase again: no new event, entity untouched
    const stamp = hub.graph.get(l.entityId)!.updatedAt;
    syncLaunchEntities(hub, NET - 290_000);
    expect(events).toEqual(['launches']);
    expect(hub.graph.get(l.entityId)!.updatedAt).toBe(stamp);
  });
});

describe('launch entity provider', () => {
  const launch = (): Launch => normalizeLaunch(raw(), NET - 86_400_000);
  const trajectory = parseTrajectory(
    JSON.stringify({
      id: 't', match: { nameContains: 'starlink group 15-15' }, azimuthDeg: 140,
      rows: [{ tSec: 0, altKm: 0, downrangeKm: 0 }, { tSec: 60, altKm: 10, downrangeKm: 5 }, { tSec: 120, altKm: 50, downrangeKm: 30 }],
    }),
    't.json',
  );

  it('is geodetic at the pad without a trajectory', () => {
    const e = launchEntity(launch());
    expect(e).toMatchObject({
      id: launch().entityId, kind: 'launch_vehicle', bodyId: 'EARTH', phase: 'SCHEDULED',
      provider: { type: 'geodetic', latDeg: 34.632, lonDeg: -120.611, altKm: 0 },
      links: { launchId: launch().id, newsQuery: 'Starlink Group 15-15' },
      attrs: { provider: 'SpaceX', vehicle: 'Falcon 9 Block 5', orbit: 'LEO', status: 'Go for Launch' },
    });
    expect(e.links!.streams).toHaveLength(3);
  });

  it('becomes a pad -> sampled ascent composite when a trajectory matches', () => {
    const e = launchEntity(launch(), trajectory);
    expect(e.provider!.type).toBe('composite');
    const p = providerFromSpec(e.provider!) as CompositeProvider;
    expect(p.segmentAt(NET - 5000)!.phase).toBe('pad');
    expect(p.segmentAt(NET + 30_000)!.phase).toBe('ascent');
    expect(p.segmentAt(NET + 200_000)).toBeNull();

    const pad = stateToGeodetic(p.stateAt(NET - 5000)!, NET - 5000, 'EARTH');
    expect(pad.lat / DEG).toBeCloseTo(34.632, 4);
    const climb = stateToGeodetic(p.stateAt(NET + 120_000)!, NET + 120_000, 'EARTH');
    expect(climb.alt).toBeCloseTo(50, 1);
    // azimuth 140 deg from Vandenberg heads south-east: lat decreases, lon increases
    expect(climb.lat / DEG).toBeLessThan(34.632);
    expect(climb.lon / DEG).toBeGreaterThan(-120.611);
  });
});
