import { readFileSync } from 'node:fs';
import { CompositeProvider, providerFromSpec, stateToGeodetic, DEG, LL2_STATUS, type Launch } from '@eio/core';
import { describe, expect, it } from 'vitest';
import { boosterEntity, launchEntity, normalizeLaunch, normalizeStreams, streamKind, syncLaunchEntities } from '../src/connectors/launchlibrary';
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

  it('is geodetic at the pad for vehicles the ascent model does not cover', () => {
    const e = launchEntity({ ...launch(), vehicle: 'Ariane 64', name: 'Ariane 6 | CSO-4' });
    expect(e).toMatchObject({
      id: launch().entityId, kind: 'launch_vehicle', bodyId: 'EARTH', phase: 'SCHEDULED',
      provider: { type: 'geodetic', latDeg: 34.632, lonDeg: -120.611, altKm: 0 },
      links: { launchId: launch().id, newsQuery: 'Starlink Group 15-15' },
      attrs: { provider: 'SpaceX', orbit: 'LEO', status: 'Go for Launch', trajectorySource: null },
    });
    expect(e.events).toBeUndefined();
    expect(e.links!.streams).toHaveLength(3);
  });

  it('attaches the modeled Falcon 9 ascent and its events when no trajectory file matches', () => {
    const e = launchEntity(launch());
    expect(e.provider!.type).toBe('composite');
    expect(e.attrs).toMatchObject({ trajectorySource: 'modeled', trajectory: null, vehicle: 'Falcon 9 Block 5', ascentInclinationDeg: 70 });
    const names = e.events!.map((ev) => ev.name);
    expect(names).toEqual(expect.arrayContaining(['LIFTOFF', 'MAX_Q', 'MECO', 'STAGE_SEP', 'SES', 'FAIRING_SEP', 'SECO', 'LANDING']));
    expect(e.events!.find((ev) => ev.name === 'MECO')!.tMs).toBe(NET + 150_000);
    expect(e.events!.every((ev, i, a) => i === 0 || ev.tMs >= a[i - 1].tMs)).toBe(true);

    const p = providerFromSpec(e.provider!) as CompositeProvider;
    expect(p.segmentAt(NET - 5000)!.phase).toBe('pad');
    expect(p.segmentAt(NET + 60_000)!.phase).toBe('stage 1 ascent');
    expect(p.segmentAt(NET + 300_000)!.phase).toBe('stage 2 burn');
    const g = stateToGeodetic(p.stateAt(NET + 150_000)!, NET + 150_000, 'EARTH');
    expect(g.alt).toBeGreaterThan(60);
    expect(g.alt).toBeLessThan(80);
    expect(g.lat / DEG).toBeLessThan(34.632); // southbound from Vandenberg
  });

  it('adds the first stage as its own entity: ascent to separation, modeled return, then landed', () => {
    const b = boosterEntity(launch())!;
    expect(b).toMatchObject({
      id: `${launch().entityId}-booster`, kind: 'stage', bodyId: 'EARTH', parentId: launch().entityId,
      attrs: { recovery: 'droneship', trajectorySource: 'modeled', landingDownrangeKm: 600 },
      render: { model: 'rocket-stage' },
    });
    expect(b.events!.map((e) => e.name)).toEqual(['ENTRY_BURN', 'LANDING_BURN', 'LANDING']);
    const p = providerFromSpec(b.provider!) as CompositeProvider;
    expect(p.segmentAt(NET - 5000)!.phase).toBe('pad');
    expect(p.segmentAt(NET + 60_000)!.phase).toBe('stage 1 ascent');
    expect(p.segmentAt(NET + 300_000)!.phase).toBe('coast');
    expect(p.segmentAt(NET + 450_000)!.phase).toBe('entry burn');
    expect(p.segmentAt(NET + 700_000)!.phase).toBe('landed');
    // it separates from the vehicle path (the upper stage keeps climbing, the booster comes back down)
    const veh = providerFromSpec(launchEntity(launch()).provider!) as CompositeProvider;
    const alt = (prov: CompositeProvider, t: number) => stateToGeodetic(prov.stateAt(NET + t * 1000)!, NET + t * 1000, 'EARTH').alt;
    expect(Math.abs(alt(p, 100) - alt(veh, 100))).toBeLessThan(0.01); // shared ascent
    expect(alt(veh, 400)).toBeGreaterThan(150);
    expect(alt(p, 400)).toBeLessThan(80);
    expect(alt(p, 700)).toBeLessThan(0.05);
  });

  it('has no booster entity when the first stage is expended, the vehicle is not modeled, or a trajectory file replaces the ascent', () => {
    expect(boosterEntity({ ...launch(), landing: { attempt: false } })).toBeNull();
    expect(boosterEntity({ ...launch(), vehicle: 'Ariane 64', name: 'Ariane 6 | CSO-4' })).toBeNull();
    expect(boosterEntity(launch(), trajectory)).toBeNull();
    expect(boosterEntity({ ...launch(), pad: undefined })).toBeNull();
  });

  it('syncLaunchEntities publishes the booster next to its launch', () => {
    const hub = new Hub();
    hub.setLaunches([launch()]);
    syncLaunchEntities(hub, NET - 7200_000);
    expect(hub.graph.get(launch().entityId)).toBeTruthy();
    expect(hub.graph.get(`${launch().entityId}-booster`)).toMatchObject({ kind: 'stage', parentId: launch().entityId });
  });

  it('reads the booster recovery plan from LL2', () => {
    const stage = (landing: unknown) => ({ ...raw(), rocket: { ...raw().rocket, launcher_stage: [{ landing }] } });
    expect(launch().landing).toBeUndefined(); // the fixture has no launcher_stage
    expect(normalizeLaunch(stage({ attempt: true, location: { abbrev: 'OCISLY' }, type: { abbrev: 'ASDS' } })).landing)
      .toEqual({ attempt: true, location: 'OCISLY', type: 'ASDS' });
    expect(normalizeLaunch(stage({ attempt: false })).landing).toEqual({ attempt: false, location: undefined, type: undefined });
  });

  it('becomes a pad -> sampled ascent composite when a trajectory matches', () => {
    const e = launchEntity(launch(), trajectory);
    expect(e.provider!.type).toBe('composite');
    expect(e.attrs).toMatchObject({ trajectory: 't', trajectorySource: 'file' });
    expect(e.events).toBeUndefined();
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
