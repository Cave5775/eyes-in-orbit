import type { NewEntity } from '../hub';

/** DSN spacecraft code -> display name and JPL Horizons id (unknown codes are skipped). */
export const DSN_TARGETS: Record<string, { name: string; horizons: string }> = {
  VGR1: { name: 'Voyager 1', horizons: '-31' },
  VGR2: { name: 'Voyager 2', horizons: '-32' },
  JWST: { name: 'James Webb Space Telescope', horizons: '-170' },
  M20: { name: 'Mars 2020 Perseverance', horizons: '-168' },
  MSL: { name: 'Mars Science Laboratory Curiosity', horizons: '-76' },
  MRO: { name: 'Mars Reconnaissance Orbiter', horizons: '-74' },
  ODY: { name: 'Mars Odyssey', horizons: '-53' },
  MVN: { name: 'MAVEN', horizons: '-202' },
  NHPC: { name: 'New Horizons', horizons: '-98' },
  JNO: { name: 'Juno', horizons: '-61' },
  LRO: { name: 'Lunar Reconnaissance Orbiter', horizons: '-85' },
  PSP: { name: 'Parker Solar Probe', horizons: '-96' },
  TGO: { name: 'ExoMars Trace Gas Orbiter', horizons: '-143' },
  MEX: { name: 'Mars Express', horizons: '-41' },
  LUCY: { name: 'Lucy', horizons: '-49' },
  PSYC: { name: 'Psyche', horizons: '-255' },
  EURC: { name: 'Europa Clipper', horizons: '-159' },
  SOLO: { name: 'Solar Orbiter', horizons: '-144' },
  BEPI: { name: 'BepiColombo', horizons: '-121' },
  STA: { name: 'STEREO-A', horizons: '-234' },
  SOHO: { name: 'SOHO', horizons: '-21' },
  TESS: { name: 'TESS', horizons: '-95' },
  CHDR: { name: 'Chandra X-ray Observatory', horizons: '-151' },
};

export const DSN_STATIONS = [
  { id: 'dsn-goldstone', name: 'Goldstone Deep Space Communications Complex', complex: 'Goldstone', latDeg: 35.4267, lonDeg: -116.89, altKm: 1.0 },
  { id: 'dsn-madrid', name: 'Madrid Deep Space Communications Complex', complex: 'Madrid', latDeg: 40.4314, lonDeg: -4.2481, altKm: 0.83 },
  { id: 'dsn-canberra', name: 'Canberra Deep Space Communication Complex', complex: 'Canberra', latDeg: -35.4014, lonDeg: 148.9817, altKm: 0.69 },
];

export const probeId = (code: string): string => `dsn-${code}`;

/** Probe entity without a provider; the Horizons connector attaches positions. */
export function probeEntity(code: string): NewEntity {
  const t = DSN_TARGETS[code];
  return {
    id: probeId(code),
    name: t.name,
    kind: 'probe',
    bodyId: 'EARTH',
    aliases: { dsn: code, horizons: t.horizons },
    group: 'dsn',
    links: { newsQuery: t.name },
    render: { colorKey: 'probe', glyph: 'diamond', label: true },
  };
}
