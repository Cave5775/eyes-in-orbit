import type { CompositeSegment, DsnSnapshot, EntityRecord, Launch, ProviderSpec } from '@eio/core';
import { launchOf } from './entity';

/** What "FIT" frames for a selection: related entity ids plus bare surface points (pads that are not entities). */
export interface Related {
  /** the selection first, then related entities that exist in the catalog */
  ids: string[];
  points: { latDeg: number; lonDeg: number }[];
}

export interface RelatedContext {
  entities: ReadonlyMap<string, EntityRecord>;
  launches: readonly Launch[];
  dsn: DsnSnapshot | null;
}

/** Pads within this distance of a vehicle's launch/landing point count as its pad. */
const PAD_RADIUS_KM = 30;

function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const r = Math.PI / 180;
  const dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Provider specs nested in a record: itself, or each composite segment. */
function leafSpecs(spec: ProviderSpec | undefined): ProviderSpec[] {
  if (!spec) return [];
  if (spec.type !== 'composite') return [spec];
  return spec.segments.flatMap((s: CompositeSegment) => leafSpecs(s.spec));
}

const isStation = (r: EntityRecord) => r.kind === 'ground_station';

function complexMatches(station: EntityRecord, complex: string): boolean {
  const c = complex.toLowerCase();
  return station.id.toLowerCase().includes(c) || station.name.toLowerCase().includes(c) || String(station.aliases.dsn ?? '').toLowerCase() === c;
}

/**
 * Entities that belong with `rec` when framing it:
 *  - parent (`parentId`) and children (entities whose `parentId` is rec);
 *  - providers it depends on (`relative` parents, e.g. the landing zone of a booster);
 *  - pads: a launch vehicle's pad from its Launch record, plus pad entities near the geodetic points of its provider;
 *  - ground station -> the probes it is currently linked to in the DSN snapshot.
 */
export function relatedFor(rec: EntityRecord, ctx: RelatedContext): Related {
  const ids = new Set<string>([rec.id]);
  const points: Related['points'] = [];
  const add = (id: string | undefined) => {
    if (id && ctx.entities.has(id)) ids.add(id);
  };

  add(rec.parentId);
  for (const other of ctx.entities.values()) if (other.parentId === rec.id) ids.add(other.id);

  const specs = leafSpecs(rec.provider);
  for (const s of specs) if (s.type === 'relative') add(s.parentId);

  // launch pad: from the launch record (LL2 pads are not entities) and from geodetic parts of the provider
  const launch = launchOf(rec, ctx.launches as Launch[]);
  if (launch?.pad) points.push({ latDeg: launch.pad.latitude, lonDeg: launch.pad.longitude });
  // a vehicle that is more than a fixed point (composite: pad -> ascent -> ...) also frames its first geodetic spot
  const spot = specs.find((s): s is Extract<ProviderSpec, { type: 'geodetic' }> => s.type === 'geodetic' && s.bodyId === 'EARTH');
  if (spot && specs.length > 1 && rec.kind !== 'pad') points.push({ latDeg: spot.latDeg, lonDeg: spot.lonDeg });
  if (points.length) {
    for (const other of ctx.entities.values()) {
      const p = other.provider;
      if (other.kind !== 'pad' || p?.type !== 'geodetic' || p.bodyId !== 'EARTH') continue;
      if (points.some((a) => haversineKm(a.latDeg, a.lonDeg, p.latDeg, p.lonDeg) <= PAD_RADIUS_KM)) ids.add(other.id);
    }
  }

  // DSN: a ground station with the probes it is currently linked to. Not the reverse: framing a probe together with
  // an Earth station would zoom out to the whole shell and make the probe's own path vanish.
  if (isStation(rec)) {
    for (const l of ctx.dsn?.links ?? []) {
      if (!complexMatches(rec, l.complex)) continue;
      for (const code of l.spacecraft) add(`dsn-${code}`);
    }
  }
  return { ids: [...ids], points };
}
