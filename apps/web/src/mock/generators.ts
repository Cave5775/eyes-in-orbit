import {
  DEG, EARTH, LL2_STATUS, MARS, MOON, Sgp4Provider, keplerState, ascentEntityEvents, bodyEntityRecords, deriveMissionState,
  missionTimingFor, modeledAscentForLaunch, modeledAscentSegments, modeledBoosterSegments, orbitSegmentsOf, stateToGeodetic, sunDirectionEci,
  type Article, type AscentSeries, type DsnSnapshot, type EntityRecord, type IssFix, type Launch, type ConnectorHealth, type Omm,
  type Sample, type StreamLink, type TelemetryPoint, type Vec3,
} from '@eio/core';

/** Deterministic PRNG so mock catalogs are stable between reloads (and testable). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MU = EARTH.gm;
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Revolutions per day for a circular orbit at altitude `altKm`. */
export const meanMotionForAlt = (altKm: number): number => {
  const a = EARTH.radiusKm + altKm;
  return (Math.sqrt(MU / (a * a * a)) * 86400) / (2 * Math.PI);
};

export interface OmmSpec {
  name: string;
  norad: number;
  epochMs: number;
  meanMotion: number;
  ecc: number;
  incl: number;
  raan: number;
  argp: number;
  ma: number;
  bstar?: number;
  /** International designator (`YYYY-NNNPPP`); a unique synthetic one is derived from `norad` when omitted. */
  cospar?: string;
}

/** COSPAR piece letters in launch order: A, B .. Z, AA, AB .. */
export function pieceLetters(i: number): string {
  if (i < 26) return String.fromCharCode(65 + i);
  const n = i - 26;
  return String.fromCharCode(65 + (Math.floor(n / 26) % 26)) + String.fromCharCode(65 + (n % 26));
}

export function makeOmm(s: OmmSpec): Omm {
  const yy = String(20 + (s.norad % 6)).padStart(2, '0');
  return {
    OBJECT_NAME: s.name,
    OBJECT_ID: s.cospar ?? `${yy}${String(s.norad % 100).padStart(2, '0')}-${String(s.norad % 999).padStart(3, '0')}A`,
    EPOCH: new Date(s.epochMs).toISOString().replace('Z', '000'),
    MEAN_MOTION: s.meanMotion,
    ECCENTRICITY: s.ecc,
    INCLINATION: s.incl,
    RA_OF_ASC_NODE: ((s.raan % 360) + 360) % 360,
    ARG_OF_PERICENTER: ((s.argp % 360) + 360) % 360,
    MEAN_ANOMALY: ((s.ma % 360) + 360) % 360,
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: 'U',
    NORAD_CAT_ID: s.norad,
    ELEMENT_SET_NO: 999,
    REV_AT_EPOCH: 1000 + (s.norad % 5000),
    BSTAR: s.bstar ?? 0.0001,
    MEAN_MOTION_DOT: 0.00002,
    MEAN_MOTION_DDOT: 0,
  };
}

const NASA_LIVE: StreamLink = { title: 'NASA Live (mock link)', url: 'https://www.youtube.com/watch?v=21X5lGlDOfg', kind: 'youtube', live: true };
const NASA_TV: StreamLink = { title: 'NASA TV', url: 'https://www.nasa.gov/nasalive', kind: 'nasa-tv', live: true };

function satRecord(omm: Omm, kind: string, group: string, colorKey: NonNullable<EntityRecord['render']>['colorKey'], now: number): EntityRecord {
  const norad = String(omm.NORAD_CAT_ID);
  return {
    id: `sat-${norad}`,
    name: omm.OBJECT_NAME,
    kind,
    bodyId: 'EARTH',
    aliases: { norad, cospar: omm.OBJECT_ID ?? '' },
    group,
    provider: { type: 'sgp4', omm },
    render: { colorKey },
    updatedAt: now,
  };
}

const GENERIC_NAMES = ['NOAA', 'METEOSAT', 'GOES', 'SENTINEL', 'LANDSAT', 'ONEWEB', 'IRIDIUM', 'GLOBALSTAR', 'COSMOS', 'YAOGAN', 'TIANHUI', 'USA', 'ORBCOMM', 'SPIRE LEMUR', 'PLANET SKYSAT'];

/** ~`count` SGP4 satellites: ISS and CSS, a Starlink-like constellation, assorted LEO/MEO/GEO/HEO, debris clouds. */
export function mockSatellites(nowMs: number, count = 2000, seed = 7): EntityRecord[] {
  const rnd = mulberry32(seed);
  const pick = (a: number, b: number) => a + (b - a) * rnd();
  const out: EntityRecord[] = [];
  let norad = 60000;

  const iss = satRecord(
    makeOmm({ name: 'ISS (ZARYA)', norad: 25544, epochMs: nowMs - 3 * HOUR, meanMotion: 15.49, ecc: 0.0005, incl: 51.64, raan: 120, argp: 90, ma: 270, bstar: 0.0002 }),
    'station', 'stations', 'station', nowMs,
  );
  iss.render = { colorKey: 'station', footprint: true, orbitLine: true, trailSeconds: 5400, label: true, model: 'iss' };
  iss.links = { streams: [NASA_LIVE, NASA_TV], newsQuery: 'International Space Station' };
  out.push(iss);
  const css = satRecord(
    makeOmm({ name: 'CSS (TIANHE)', norad: 48274, epochMs: nowMs - 5 * HOUR, meanMotion: 15.6, ecc: 0.0004, incl: 41.47, raan: 310, argp: 60, ma: 40 }),
    'station', 'stations', 'station', nowMs,
  );
  css.links = { newsQuery: 'Tiangong space station' };
  out.push(css);

  // Starlink: shells of 22-satellite planes
  const starlinkCount = Math.round(count * 0.55);
  const shells = [
    { share: 0.6, alt: 550, incl: 53.0 },
    { share: 0.15, alt: 540, incl: 53.2 },
    { share: 0.1, alt: 570, incl: 70.0 },
    { share: 0.15, alt: 560, incl: 97.6 },
  ];
  let slNum = 1000;
  let slLaunch = 0;
  for (const sh of shells) {
    const n = Math.round(starlinkCount * sh.share);
    const planes = Math.max(1, Math.ceil(n / 22));
    for (let k = 0; k < n; k++, norad++, slNum++) {
      const p = k % planes;
      const j = Math.floor(k / planes);
      // one plane = one launch (Falcon 9 batch), so each plane forms a launch group
      const launchNo = String(100 + slLaunch + p).padStart(3, '0');
      out.push(satRecord(
        makeOmm({
          name: `STARLINK-${slNum}`, norad, cospar: `2024-${launchNo}${pieceLetters(j)}`, epochMs: nowMs - pick(0, 2) * DAY,
          meanMotion: meanMotionForAlt(sh.alt) + pick(-0.002, 0.002), ecc: pick(0.00005, 0.0003), incl: sh.incl + pick(-0.02, 0.02),
          raan: (p * 360) / planes, argp: pick(0, 360), ma: (j * 360) / 22 + p * 7, bstar: 0.0003,
        }),
        'satellite', 'starlink', 'starlink', nowMs,
      ));
    }
    slLaunch += planes;
  }
  // one Starlink gets the generic satellite model (zoom to it: bus, two panels turned toward the Sun)
  const model0 = out.find((e) => e.name === 'STARLINK-1000');
  if (model0) model0.render = { ...model0.render, model: 'satellite' };

  // debris clouds from three fragmentation events; each cloud is one launch (shared YYYY-NNN) and one CelesTrak-style group
  const debrisCount = Math.round(count * 0.16);
  const clouds = [
    { parent: 'COSMOS 2251', launch: '1993-036', group: 'cosmos-2251-debris', parentNorad: 22675, share: 0.47, alt: 790, incl: 74.0 },
    { parent: 'IRIDIUM 33', launch: '1997-051', group: 'iridium-33-debris', parentNorad: 24946, share: 0.19, alt: 780, incl: 86.4 },
    { parent: 'FENGYUN 1C', launch: '1999-025', group: 'fengyun-1c-debris', parentNorad: 25730, share: 0.34, alt: 850, incl: 98.8 },
  ];
  for (const c of clouds) {
    const n = Math.max(2, Math.round(debrisCount * c.share));
    for (let k = 0; k < n; k++) {
      const parent = k === 0;
      const cloudNorad = parent ? c.parentNorad : norad++;
      out.push(satRecord(
        makeOmm({
          name: parent ? c.parent : `${c.parent} DEB`, norad: cloudNorad, cospar: `${c.launch}${pieceLetters(k)}`,
          epochMs: nowMs - pick(0, 5) * DAY,
          meanMotion: meanMotionForAlt(c.alt + pick(-120, 120)), ecc: pick(0.0005, 0.01), incl: c.incl + pick(-0.8, 0.8),
          raan: pick(0, 360), argp: pick(0, 360), ma: pick(0, 360), bstar: 0.002,
        }),
        'debris', c.group, 'debris', nowMs,
      ));
    }
  }

  // everything else: a mix of orbit classes
  while (out.length < count) {
    const roll = rnd();
    const base = { norad, epochMs: nowMs - pick(0, 7) * DAY, raan: pick(0, 360), argp: pick(0, 360), ma: pick(0, 360) };
    const name = `${GENERIC_NAMES[Math.floor(rnd() * GENERIC_NAMES.length)]} ${Math.floor(pick(1, 999))}`;
    let omm: Omm;
    let nav = false;
    if (roll < 0.55) omm = makeOmm({ ...base, name, meanMotion: meanMotionForAlt(pick(400, 1300)), ecc: pick(0.0001, 0.02), incl: pick(20, 100) });
    else if (roll < 0.75) omm = makeOmm({ ...base, name, meanMotion: meanMotionForAlt(pick(500, 800)), ecc: pick(0.0001, 0.002), incl: pick(97, 98.8) });
    else if (roll < 0.85) {
      // GPS-like MEO satellites form the navigation group (CelesTrak `gps-ops`)
      nav = true;
      omm = makeOmm({ ...base, name: `GPS BIIR-${Math.floor(pick(1, 40))}`, meanMotion: 2.0057, ecc: pick(0.001, 0.02), incl: pick(54.5, 56.5) });
    }
    else if (roll < 0.95) omm = makeOmm({ ...base, name: `GEO COMSAT ${Math.floor(pick(1, 200))}`, meanMotion: 1.0027, ecc: pick(0.0001, 0.001), incl: pick(0.02, 0.12) });
    else omm = makeOmm({ ...base, name: `MOLNIYA ${Math.floor(pick(1, 60))}`, meanMotion: 2.0058, ecc: pick(0.65, 0.74), incl: 63.4 });
    out.push(nav ? satRecord(omm, 'satellite', 'gps-ops', 'navigation', nowMs) : satRecord(omm, 'satellite', 'active', 'satellite', nowMs));
    norad++;
  }
  return out;
}

// ---------------------------------------------------------------- launches

const PADS = {
  kscA: { name: 'Launch Complex 39A', latitude: 28.6082, longitude: -80.6041, location: 'Kennedy Space Center, FL, USA', countryCode: 'USA' },
  vsfb: { name: 'Space Launch Complex 4E', latitude: 34.632, longitude: -120.611, location: 'Vandenberg SFB, CA, USA', countryCode: 'USA' },
  stbs: { name: 'Orbital Launch Mount A', latitude: 25.9972, longitude: -97.1561, location: 'Starbase, TX, USA', countryCode: 'USA' },
  bkn: { name: 'Site 31/6', latitude: 45.996, longitude: 63.564, location: 'Baikonur Cosmodrome, Kazakhstan', countryCode: 'KAZ' },
  kou: { name: 'ELA-4', latitude: 5.239, longitude: -52.768, location: 'Guiana Space Centre, French Guiana', countryCode: 'GUF' },
  mahia: { name: 'Launch Complex 1B', latitude: -39.2615, longitude: 177.865, location: 'Mahia Peninsula, New Zealand', countryCode: 'NZL' },
};

interface LaunchDef {
  key: string;
  name: string;
  provider: string;
  vehicle: string;
  mission: Launch['mission'];
  pad: keyof typeof PADS;
  offsetMs: number;
  statusId: number;
  statusName: string;
  abbrev: string;
}

const LAUNCH_DEFS: LaunchDef[] = [
  { key: 'm01', name: 'Falcon 9 Block 5 | Starlink Group 10-31', provider: 'SpaceX', vehicle: 'Falcon 9 Block 5', mission: { name: 'Starlink Group 10-31', type: 'Communications', orbit: 'Low Earth Orbit', description: 'A batch of Starlink broadband satellites.' }, pad: 'vsfb', offsetMs: -3 * HOUR, statusId: LL2_STATUS.SUCCESS, statusName: 'Launch Successful', abbrev: 'Success' },
  { key: 'm02', name: 'Falcon 9 Block 5 | Crew-14', provider: 'SpaceX', vehicle: 'Falcon 9 Block 5', mission: { name: 'Crew-14', type: 'Human Exploration', orbit: 'Low Earth Orbit', description: 'Crew rotation to the ISS.' }, pad: 'kscA', offsetMs: 12 * MIN, statusId: LL2_STATUS.GO, statusName: 'Go for Launch', abbrev: 'Go' },
  { key: 'm07', name: 'Falcon 9 Block 5 | Starlink Group 15-15', provider: 'SpaceX', vehicle: 'Falcon 9 Block 5', mission: { name: 'Starlink Group 15-15', type: 'Communications', orbit: 'Low Earth Orbit', description: 'A batch of 27 satellites for the Starlink mega-constellation - SpaceX\'s project for space-based Internet communication system.' }, pad: 'vsfb', offsetMs: 40 * MIN, statusId: LL2_STATUS.GO, statusName: 'Go for Launch', abbrev: 'Go' },
  { key: 'm03', name: 'Ariane 6 | CSO-4', provider: 'Arianespace', vehicle: 'Ariane 64', mission: { name: 'CSO-4', type: 'Earth Science', orbit: 'Sun-Synchronous Orbit', description: 'French military optical reconnaissance satellite.' }, pad: 'kou', offsetMs: 5 * HOUR + 20 * MIN, statusId: LL2_STATUS.GO, statusName: 'Go for Launch', abbrev: 'Go' },
  { key: 'm04', name: 'Soyuz 2.1a | Progress MS-35', provider: 'Roscosmos', vehicle: 'Soyuz 2.1a', mission: { name: 'Progress MS-35', type: 'Resupply', orbit: 'Low Earth Orbit', description: 'Cargo resupply to the ISS.' }, pad: 'bkn', offsetMs: 30 * HOUR, statusId: LL2_STATUS.TBC, statusName: 'To Be Confirmed', abbrev: 'TBC' },
  { key: 'm05', name: 'Starship | Flight 14', provider: 'SpaceX', vehicle: 'Starship', mission: { name: 'Starship Flight 14', type: 'Test Flight', orbit: 'Suborbital', description: 'Integrated flight test.' }, pad: 'stbs', offsetMs: 3 * DAY + 2 * HOUR, statusId: LL2_STATUS.TBD, statusName: 'To Be Determined', abbrev: 'TBD' },
  { key: 'm06', name: 'Electron | Rideshare', provider: 'Rocket Lab', vehicle: 'Electron', mission: { name: 'Rideshare', type: 'Dedicated Rideshare', orbit: 'Sun-Synchronous Orbit', description: 'Small satellite rideshare.' }, pad: 'mahia', offsetMs: 9 * DAY, statusId: LL2_STATUS.HOLD, statusName: 'On Hold', abbrev: 'Hold' },
];

export function mockLaunches(nowMs: number): { launches: Launch[]; entities: EntityRecord[] } {
  const launches: Launch[] = [];
  const entities: EntityRecord[] = [];
  for (const d of LAUNCH_DEFS) {
    const net = nowMs + d.offsetMs;
    const pad = PADS[d.pad];
    const timing = missionTimingFor({ vehicle: d.vehicle, name: d.name });
    const state = deriveMissionState({ statusId: d.statusId, netMs: net, nowMs, ...timing });
    const streams = d.offsetMs < 12 * HOUR ? [NASA_LIVE, NASA_TV] : [NASA_TV];
    const id = `mock-${d.key}`;
    const entityId = `launch-${id}`;
    launches.push({
      id, name: d.name, status: { id: d.statusId, name: d.statusName, abbrev: d.abbrev },
      net: new Date(net).toISOString(), windowStart: new Date(net).toISOString(), windowEnd: new Date(net + 30 * MIN).toISOString(),
      provider: d.provider, vehicle: d.vehicle, mission: d.mission, pad, streams, phase: state.phase, hold: state.hold, entityId,
    });
    // Falcon 9 launches get the same MODELED nominal ascent the server attaches (composite: pad, the ascent samples, then the
    // modeled orbit and the pad marker); a failed flight skips the orbit
    const modeled = modeledAscentForLaunch(launches[launches.length - 1]);
    const failed = d.statusId === LL2_STATUS.FAILURE || d.statusId === LL2_STATUS.PARTIAL_FAILURE;
    const ascentSegments = modeled ? modeledAscentSegments(net, { latDeg: pad.latitude, lonDeg: pad.longitude }, modeled, { orbit: !failed }) : null;
    entities.push({
      id: entityId, name: d.name, kind: 'launch_vehicle', bodyId: 'EARTH', aliases: { ll2: id }, group: 'launch',
      provider: ascentSegments
        ? { type: 'composite', segments: ascentSegments }
        : { type: 'geodetic', bodyId: 'EARTH', latDeg: pad.latitude, lonDeg: pad.longitude, altKm: 0.01 },
      phase: state.phase, links: { streams, newsQuery: d.mission?.name ?? d.name, launchId: id },
      events: modeled ? ascentEntityEvents(modeled.events, net) : undefined,
      render: { colorKey: 'vehicle', glyph: 'triangle', label: true },
      attrs: {
        provider: d.provider, vehicle: d.vehicle, orbit: d.mission?.orbit ?? null, pad: pad.name, status: d.statusName,
        trajectorySource: modeled ? 'modeled' : null,
        trajectoryNote: modeled ? 'MODELED nominal ascent, not measured' : null,
        ascentInclinationDeg: modeled?.inclinationDeg ?? null,
        ascentAzimuthDeg: modeled?.azimuthDeg ?? null,
      },
      updatedAt: nowMs,
    });
    // the recovered first stage as its own entity, like the server's `launch-<id>-booster`
    const boosterSegments = modeled ? modeledBoosterSegments(net, { latDeg: pad.latitude, lonDeg: pad.longitude }, modeled) : null;
    if (modeled?.booster && boosterSegments) {
      entities.push({
        id: `${entityId}-booster`, name: `${d.name} (booster)`, kind: 'stage', bodyId: 'EARTH', parentId: entityId, aliases: {}, group: 'launch',
        provider: { type: 'composite', segments: boosterSegments },
        events: ascentEntityEvents(modeled.events.filter((e) => e.track === 'booster'), net),
        render: { colorKey: 'vehicle', glyph: 'triangle', trailSeconds: 120, label: true, model: 'rocket-stage' },
        attrs: {
          launch: d.name, recovery: modeled.recovery, landingDownrangeKm: Math.round(modeled.booster.landingDownrangeKm),
          trajectorySource: 'modeled', trajectoryNote: 'MODELED booster return path through the event times, not measured',
        },
        updatedAt: nowMs,
      });
    }
    // the payload as its own satellite, like the server's `launch-<id>-payload`: only for launches that are flying or flown
    // (the mock's phases are fixed at load) and reached orbit; it follows the keplerian part of the vehicle's composite
    const orbit = orbitSegmentsOf(ascentSegments ?? undefined);
    if (orbit && ['ACTIVE_ASCENT', 'ORBIT_INSERTION', 'ON_ORBIT'].includes(state.phase)) {
      entities.push({
        id: `${entityId}-payload`, name: `${d.mission?.name ?? d.name} (payload)`, kind: 'satellite', bodyId: 'EARTH', parentId: entityId, aliases: {}, group: 'launch',
        provider: { type: 'composite', segments: orbit },
        render: { colorKey: 'satellite', label: true, orbitLine: true },
        attrs: {
          provider: d.provider, launch: d.name, mission: d.mission?.name ?? null, orbit: d.mission?.orbit ?? null,
          ascentInclinationDeg: modeled?.inclinationDeg ?? null,
          trajectorySource: 'modeled',
          trajectoryNote: 'MODELED two-body orbit (no J2, no drag) from the end of the modeled ascent, about 12 h, until a TLE exists',
        },
        updatedAt: nowMs,
      });
    }
  }
  launches.sort((a, b) => Date.parse(a.net) - Date.parse(b.net));
  return { launches, entities };
}

/** Offline stand-in for `GET /api/telemetry/:launchId`: the modeled series, nothing measured. */
export function mockAscentSeries(launch: Launch): AscentSeries | null {
  const modeled = modeledAscentForLaunch(launch);
  if (!modeled) return null;
  return {
    launchId: launch.id, entityId: launch.entityId, liftoffMs: Date.parse(launch.net),
    source: 'modeled', modeled, file: null, live: null,
  };
}

// ---------------------------------------------------------------- deep space / ground

const STATIONS = [
  { id: 'dsn-goldstone', name: 'Goldstone DSN Complex', lat: 35.4267, lon: -116.89, code: 'GDSCC' },
  { id: 'dsn-madrid', name: 'Madrid DSN Complex', lat: 40.4314, lon: -4.2481, code: 'MDSCC' },
  { id: 'dsn-canberra', name: 'Canberra DSN Complex', lat: -35.4014, lon: 148.9817, code: 'CDSCC' },
];

const unitFromRaDec = (raDeg: number, decDeg: number): Vec3 => [
  Math.cos(decDeg * DEG) * Math.cos(raDeg * DEG), Math.cos(decDeg * DEG) * Math.sin(raDeg * DEG), Math.sin(decDeg * DEG),
];

/**
 * Samples over [now-3d, now+7d] in 30 minute steps, as the server's Horizons connector produces for the default
 * (geocentric) targets; `win` overrides the window and step (LRO: -1 d .. +3 d, 5 min) and `at` may return a
 * 6-vector (position and velocity, km and km/s) like the Horizons rows.
 */
function probeSamples(nowMs: number, at: (t: number) => Vec3 | number[], win = { pastDays: 3, futureDays: 7, stepMin: 30 }): Sample[] {
  const out: Sample[] = [];
  for (let t = nowMs - win.pastDays * DAY; t <= nowMs + win.futureDays * DAY; t += win.stepMin * MIN) out.push([t, ...at(t)] as Sample);
  return out;
}

/**
 * The mock LRO: polar orbit about the Moon, 50 x 150 km altitude (period ~1.96 h), elements at `nowMs`.
 * The plane contains the Moon's spin axis (pole RA ~270 deg, so i = 90 deg and raan = 270 deg in the equatorial axes).
 */
const LRO_ORBIT = (nowMs: number) => {
  const a = MOON.radiusKm + 100, e = 50 / a;
  return { a, e, i: 90 * DEG, raan: 270 * DEG, argp: 270 * DEG, m0: 0, epochMs: nowMs };
};

/**
 * The mock MRO: near-polar sun-synchronous orbit about Mars, 255 x 320 km altitude (period ~113 min), elements at `nowMs`.
 * i = 93 deg, so the Mars-inertial track is a tilted ring around Mars, never a point on the Earth-centred scale.
 */
const MRO_ORBIT = (nowMs: number) => {
  const a = MARS.radiusKm + 288, e = 32 / a;
  return { a, e, i: 93 * DEG, raan: 20 * DEG, argp: 270 * DEG, m0: 0, epochMs: nowMs };
};

/** The body entities, built by the same core function as the server's `bodies` connector so the mock cannot drift. */
export const mockBodies = (nowMs: number): EntityRecord[] => bodyEntityRecords(undefined, nowMs);

export function mockGroundAndProbes(nowMs: number): EntityRecord[] {
  const out: EntityRecord[] = STATIONS.map((s) => ({
    id: s.id, name: s.name, kind: 'ground_station', bodyId: 'EARTH', aliases: { dsn: s.code }, group: 'dsn',
    provider: { type: 'geodetic', bodyId: 'EARTH', latDeg: s.lat, lonDeg: s.lon, altKm: 0.5 },
    render: { colorKey: 'ground', glyph: 'square', label: true }, updatedAt: nowMs,
  }));

  const vgr1 = unitFromRaDec(257.9, 12.2);
  const vgr1R0 = 2.5e10;
  out.push({
    id: 'dsn-VGR1', name: 'Voyager 1', kind: 'probe', bodyId: 'EARTH', aliases: { dsn: 'VGR1', horizons: '-31' }, group: 'dsn',
    provider: { type: 'sampled', frame: 'EARTH:inertial', samples: probeSamples(nowMs, (t) => vgr1.map((c) => c * (vgr1R0 + 17 * ((t - nowMs) / 1000))) as Vec3) },
    links: { newsQuery: 'Voyager 1' }, render: { colorKey: 'probe', glyph: 'diamond', label: true },
    attrs: { rangeKm: vgr1R0, rtltSec: (2 * vgr1R0) / 299792.458, dataRate: 160, dish: 'DSS-14' }, updatedAt: nowMs,
  });
  out.push({
    id: 'dsn-JWST', name: 'James Webb Space Telescope', kind: 'probe', bodyId: 'EARTH', aliases: { dsn: 'JWST', horizons: '-170' }, group: 'dsn',
    provider: { type: 'sampled', frame: 'EARTH:inertial', samples: probeSamples(nowMs, (t) => sunDirectionEci(t).map((c) => -c * 1.5e6) as Vec3) },
    links: { newsQuery: 'James Webb Space Telescope' }, render: { colorKey: 'probe', glyph: 'diamond', label: true },
    attrs: { rangeKm: 1.5e6, rtltSec: 10, dataRate: 28_000_000, dish: 'DSS-63' }, updatedAt: nowMs,
  });
  const mroOrbit = MRO_ORBIT(nowMs);
  out.push({
    // Mars-centred like the server's Horizons target (500@499, MARS:inertial, position and velocity, 5 min steps, -1 d .. +3 d)
    id: 'dsn-MRO', name: 'Mars Reconnaissance Orbiter', kind: 'probe', bodyId: 'MARS', aliases: { dsn: 'MRO', horizons: '-74' }, group: 'dsn',
    provider: {
      type: 'sampled', frame: 'MARS:inertial',
      samples: probeSamples(nowMs, (t) => { const s = keplerState(mroOrbit, MARS.gm, t); return [...s.r, ...s.v]; }, { pastDays: 1, futureDays: 3, stepMin: 5 }),
    },
    links: { newsQuery: 'Mars Reconnaissance Orbiter' }, render: { colorKey: 'probe', glyph: 'diamond', label: true },
    attrs: {
      rangeKm: 2.2e8, rtltSec: 1470, dataRate: 2_000_000, dish: 'DSS-43',
      trackCentre: 'Mars', trackNote: 'Track is Mars-centred (Horizons 500@499, 5 min steps, -1 d to +3 d), not Earth-centred',
    },
    updatedAt: nowMs,
  });

  // LRO: Moon-centred like the server's Horizons target (MOON:inertial, position and velocity, 5 min steps, -1 d .. +3 d)
  const lroOrbit = LRO_ORBIT(nowMs);
  out.push({
    id: 'dsn-LRO', name: 'Lunar Reconnaissance Orbiter', kind: 'probe', bodyId: 'MOON', aliases: { dsn: 'LRO', horizons: '-85' }, group: 'dsn',
    provider: {
      type: 'sampled', frame: 'MOON:inertial',
      samples: probeSamples(nowMs, (t) => { const s = keplerState(lroOrbit, MOON.gm, t); return [...s.r, ...s.v]; }, { pastDays: 1, futureDays: 3, stepMin: 5 }),
    },
    links: { newsQuery: 'Lunar Reconnaissance Orbiter' }, render: { colorKey: 'probe', glyph: 'diamond', label: true },
    attrs: { trackCentre: 'Moon', trackNote: 'Track is Moon-centred (Horizons 500@301, 5 min steps, -1 d to +3 d), not Earth-centred' },
    updatedAt: nowMs,
  });
  return out;
}

export function mockDsn(nowMs: number): DsnSnapshot {
  return {
    fetchedAt: nowMs,
    links: [
      { dish: 'DSS-14', complex: 'Goldstone', spacecraft: ['VGR1'], azimuthDeg: 211.4, elevationDeg: 21.3, rangeKm: 2.5e10, rtltSec: 166_800, downlink: { active: true, band: 'X', frequencyHz: 8.42e9, dataRateBps: 160 }, uplink: { active: true, band: 'X', dataRateBps: 16 } },
      { dish: 'DSS-63', complex: 'Madrid', spacecraft: ['JWST'], azimuthDeg: 143.2, elevationDeg: 48.7, rangeKm: 1.5e6, rtltSec: 10, downlink: { active: true, band: 'Ka', frequencyHz: 2.58e10, dataRateBps: 28_000_000 } },
      { dish: 'DSS-43', complex: 'Canberra', spacecraft: ['MRO'], azimuthDeg: 62.0, elevationDeg: 33.9, rangeKm: 2.2e8, rtltSec: 1470, downlink: { active: true, band: 'X', frequencyHz: 8.44e9, dataRateBps: 2_000_000 }, uplink: { active: false, band: 'X' } },
      { dish: 'DSS-34', complex: 'Canberra', spacecraft: ['MRO', 'JWST'], azimuthDeg: 301.8, elevationDeg: 12.2, rangeKm: 2.2e8, rtltSec: 1470, downlink: { active: false } },
    ],
  };
}

const HEADLINES: [string, string][] = [
  ['Crew-14 stacked and ready at Kennedy as countdown approaches', 'SpaceNews'],
  ['Starlink launch from Vandenberg adds 24 more satellites', 'NASASpaceflight'],
  ['Voyager 1 science instruments continue to return data from interstellar space', 'NASA'],
  ['Ariane 6 prepares for CSO-4 reconnaissance satellite launch', 'ESA'],
  ['JWST finds earliest known galaxy candidates in deep-field survey', 'Space.com'],
  ['Mars Reconnaissance Orbiter images fresh avalanche scars near the north pole', 'Spaceflight Now'],
  ['Starship upper stage static fire completed ahead of next flight test', 'Ars Technica'],
  ['ISS reboost planned to avoid debris from fragmented rocket body', 'SpaceNews'],
  ['Rocket Lab Electron rideshare slips as ground team resolves sensor fault', 'Space.com'],
  ['Progress MS-35 cargo ship cleared for launch to the station', 'Roscosmos'],
  ['Deep Space Network schedules maintenance outage at Canberra complex', 'NASA'],
  ['New debris cloud tracked after Cosmos fragmentation event', 'Space-Track Blog'],
];

export function mockNews(nowMs: number, q?: string): Article[] {
  const arts = HEADLINES.map(([title, site], i) => ({
    id: 9000 + i, title, site, url: 'https://www.spaceflightnewsapi.net/', publishedAt: new Date(nowMs - (i * 47 + 5) * MIN).toISOString(),
    summary: 'Mock article generated offline for UI demonstration.',
  }));
  const needle = q?.toLowerCase().trim();
  return needle ? arts.filter((a) => a.title.toLowerCase().includes(needle.split(/\s+/)[0])) : arts;
}

export function mockHealth(nowMs: number): ConnectorHealth[] {
  const ok = (id: string, ageSec: number, runs: number, note?: string): ConnectorHealth => ({ id, status: 'ok', lastOkAt: nowMs - ageSec * 1000, runs, note, nextRunAt: nowMs + 60_000 });
  return [
    ok('celestrak', 1800, 4, 'mock'),
    ok('launch-library-2', 240, 20, 'mock'),
    ok('spaceflight-news', 95, 31, 'mock'),
    ok('dsn-now', 12, 340, 'mock'),
    ok('horizons', 7200, 2, 'mock'),
    { id: 'bodies', status: 'ok', lastOkAt: nowMs, runs: 1, note: '4 bodies (mock)' },
    { id: 'iss-live', status: 'stub', runs: 0, note: 'mock' },
  ];
}

export function mockIssFix(omm: Omm, tMs: number): IssFix | undefined {
  const s = new Sgp4Provider(omm).stateAt(tMs);
  if (!s?.v) return undefined;
  const g = stateToGeodetic(s, tMs, 'EARTH');
  const speed = Math.hypot(...s.v);
  const sun = sunDirectionEci(tMs);
  const along = s.r[0] * sun[0] + s.r[1] * sun[1] + s.r[2] * sun[2];
  // cylindrical Earth shadow
  const lit = along > 0 || Math.sqrt(Math.max(0, Math.hypot(...s.r) ** 2 - along ** 2)) > EARTH.radiusKm;
  return {
    t: tMs, latitude: g.lat / DEG, longitude: g.lon / DEG, altitudeKm: g.alt, velocityKmh: speed * 3600,
    visibility: lit ? 'daylight' : 'eclipsed', footprintKm: 2 * EARTH.radiusKm * Math.acos(EARTH.radiusKm / (EARTH.radiusKm + g.alt)),
  };
}

export function mockIssTelemetry(tMs: number): TelemetryPoint[] {
  const w = (period: number, amp: number, base: number) => base + amp * Math.sin((tMs / period) * 2 * Math.PI);
  return [
    { id: 'CABIN_PRESS', label: 'Cabin pressure', value: w(900_000, 0.02, 14.7).toFixed(2), unit: 'psia', t: tMs },
    { id: 'CABIN_TEMP', label: 'Cabin temperature', value: w(1_800_000, 0.4, 22.5).toFixed(1), unit: 'C', t: tMs },
    { id: 'O2_PART', label: 'O2 partial pressure', value: w(1_200_000, 0.05, 3.1).toFixed(2), unit: 'psia', t: tMs },
    { id: 'URINE_TANK', label: 'Urine tank', value: String(Math.round(w(7_200_000, 12, 58))), unit: '%', t: tMs },
    { id: 'SOLAR_ARRAY', label: 'Solar array power', value: w(5_580_000, 20, 60).toFixed(1), unit: 'kW', t: tMs },
    { id: 'CMG_SPIN', label: 'CMG 1 spin rate', value: w(3_000_000, 5, 6600).toFixed(0), unit: 'rpm', t: tMs },
  ];
}
