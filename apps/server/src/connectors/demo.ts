import { defaultBodies, destinationPoint, profileToFixedSamples, type CompositeSegment, type Sample } from '@eio/core';
import type { Connector } from '../connector';
import type { NewEntity } from '../hub';

/** Always-on extensibility demo: a booster (composite), a drone (relative ENU) and a Mars rover (other body). */
const CYCLE_MS = 600_000;
const CYCLES_AHEAD = 6;
const PAD = { latDeg: 28.6082, lonDeg: -80.6041 };
const LZ_DISTANCE_KM = 8;
const ASCENT_KM = { downrange: 40, altitude: 70 };
const EARTH = defaultBodies.get('EARTH');

const sec = (sec: number) => sec * 1000;

/** Build the demo entities for the cycles starting at `serverStartMs`, covering `nowMs` onward. */
export function buildDemoEntities(serverStartMs: number, nowMs: number): NewEntity[] {
  const lz = destinationPoint(PAD.latDeg, PAD.lonDeg, 90, LZ_DISTANCE_KM, EARTH.radiusKm);
  const firstCycle = Math.max(0, Math.floor((nowMs - serverStartMs) / CYCLE_MS));
  const segments: CompositeSegment[] = [];
  const droneSamples: Sample[] = [];

  const padSpec = { type: 'geodetic', bodyId: 'EARTH', latDeg: PAD.latDeg, lonDeg: PAD.lonDeg, altKm: 0 } as const;
  const lzSpec = { type: 'geodetic', bodyId: 'EARTH', latDeg: lz.latDeg, lonDeg: lz.lonDeg, altKm: 0 } as const;

  for (let k = firstCycle; k < firstCycle + CYCLES_AHEAD; k++) {
    const t0 = serverStartMs + k * CYCLE_MS;
    const liftoff = t0 + sec(30), landingStart = t0 + sec(150), landed = t0 + sec(330);

    const ascentRows = Array.from({ length: 25 }, (_, i) => {
      const s = i / 24;
      return { tSec: s * 120, altKm: ASCENT_KM.altitude * s ** 1.6, downrangeKm: ASCENT_KM.downrange * s ** 2.4 };
    });
    // descent relative to the landing zone: starts where the ascent ended (east offset = downrange - LZ distance)
    const landingSamples: Sample[] = Array.from({ length: 37 }, (_, i) => {
      const s = i / 36;
      return [landingStart + s * sec(180), (ASCENT_KM.downrange - LZ_DISTANCE_KM) * (1 - s) ** 1.5, 0, ASCENT_KM.altitude * (1 - s) ** 2];
    });

    segments.push(
      { fromMs: t0, toMs: liftoff - 1, phase: 'pad', spec: padSpec },
      { fromMs: liftoff, toMs: landingStart - 1, phase: 'ascent', spec: { type: 'sampled', frame: 'EARTH:fixed', samples: profileToFixedSamples(EARTH, PAD, 90, liftoff, ascentRows) } },
      { fromMs: landingStart, toMs: landed - 1, phase: 'landing', spec: { type: 'relative', parentId: 'demo-lz', mode: 'enu', samples: landingSamples } },
      { fromMs: landed, toMs: t0 + CYCLE_MS - 1, phase: 'landed', spec: lzSpec },
    );
  }

  // drone circles the landing zone (radius 120 m, 60 m up, one lap per 45 s) for the whole window
  const windowStart = serverStartMs + firstCycle * CYCLE_MS;
  for (let t = windowStart; t <= windowStart + CYCLES_AHEAD * CYCLE_MS; t += 2000) {
    const a = ((t - windowStart) / 45_000) * 2 * Math.PI;
    droneSamples.push([t, 0.12 * Math.cos(a), 0.12 * Math.sin(a), 0.06]);
  }

  const group = 'demo';
  return [
    {
      id: 'demo-pad', name: 'Demo launch pad', kind: 'pad', bodyId: 'EARTH', aliases: {}, group, provider: padSpec,
      render: { colorKey: 'ground', glyph: 'square' },
    },
    {
      id: 'demo-lz', name: 'Demo landing zone', kind: 'pad', bodyId: 'EARTH', aliases: {}, group, provider: lzSpec,
      render: { colorKey: 'ground', glyph: 'ring' },
    },
    {
      id: 'demo-booster', name: 'Demo booster', kind: 'stage', bodyId: 'EARTH', aliases: {}, group,
      provider: { type: 'composite', segments },
      render: { colorKey: 'vehicle', glyph: 'triangle', trailSeconds: 120, label: true, model: 'rocket-stage' },
      attrs: { note: 'looping demo: pad, ascent, landing burn (relative ENU), landed', cycleSec: CYCLE_MS / 1000 },
    },
    {
      id: 'demo-drone', name: 'Demo drone', kind: 'drone', bodyId: 'EARTH', parentId: 'demo-lz', aliases: {}, group,
      provider: { type: 'relative', parentId: 'demo-lz', mode: 'enu', samples: droneSamples },
      render: { colorKey: 'aircraft', glyph: 'dot', trailSeconds: 60, label: true },
      attrs: { note: 'orbits the landing zone, relative ENU provider' },
    },
    {
      id: 'demo-rover', name: 'Demo rover (Jezero)', kind: 'rover', bodyId: 'MARS', aliases: {}, group,
      provider: { type: 'geodetic', bodyId: 'MARS', latDeg: 18.4447, lonDeg: 77.4508, altKm: -2.6 },
      render: { colorKey: 'rover', glyph: 'square', label: true },
      attrs: { note: 'geodetic on MARS:fixed' },
    },
  ];
}

let startMs = Date.now();

export const demo: Connector = {
  id: 'demo',
  intervalMs: CYCLE_MS * 2,
  network: false,
  start() {
    startMs = Date.now();
  },
  async run(ctx) {
    const n = ctx.hub.upsert(...buildDemoEntities(startMs, Date.now()));
    ctx.health.note = `looping every ${CYCLE_MS / 60_000} min since server start`;
    if (n) ctx.log(`${n} demo entities updated`);
  },
};
