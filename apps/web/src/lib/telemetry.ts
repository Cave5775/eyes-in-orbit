import {
  CompositeProvider, DEG, Sgp4Provider, norm, stateToGeodetic, type EntityGraph, type EntityRecord, type FrameId,
} from '@eio/core';
import { SHELL_THRESHOLD_KM } from './deepspace';
import { EARTH_CENTRE, entityRelativeToCentre, graphLookup, isEarthCentre, type Centre } from './frame';
import { orbitPeriodSec } from './orbit';

export interface Telemetry {
  /** geocentric distance, km */
  rangeKm: number;
  latDeg?: number;
  lonDeg?: number;
  altKm?: number;
  speedKmS?: number;
  periodSec?: number;
  confidence?: number;
  phase?: string;
  /** drawn on the compressed deep-space shell */
  shell: boolean;
  /** SGP4 element age, days */
  elementAgeDays?: number;
  /** distance and speed relative to the frame centre, when that is not the Earth (and not the entity itself) */
  refRangeKm?: number;
  refSpeedKmS?: number;
}

/**
 * Live state of an entity from the shared graph at sim time `t`, in display-ready units. `centre` is the frame of
 * reference: a body (the core frame hop re-expresses the state in its inertial frame) or an entity (difference of two
 * Earth-inertial states, the centre entity must be in the graph).
 */
export function computeTelemetry(graph: EntityGraph, rec: EntityRecord, t: number, centre: Centre = EARTH_CENTRE): Telemetry | null {
  const s = graph.stateOf(rec.id, t);
  if (!s) return null;
  const inertial = graph.stateIn(rec.id, t, 'EARTH:inertial');
  const rangeKm = inertial ? norm(inertial.r) : NaN;
  const shell = rangeKm > SHELL_THRESHOLD_KM;
  const out: Telemetry = { rangeKm, shell, confidence: s.confidence, speedKmS: inertial?.v ? norm(inertial.v) : undefined };

  if (!isEarthCentre(centre) && !(centre.kind === 'entity' && centre.id === rec.id)) {
    const rel = centre.kind === 'body'
      ? graph.stateIn(rec.id, t, `${centre.id}:inertial` as FrameId)
      : entityRelativeToCentre(rec.id, centre, t, graphLookup(graph));
    if (rel) {
      out.refRangeKm = norm(rel.r);
      out.refSpeedKmS = rel.v ? norm(rel.v) : undefined;
    }
  }

  // surface coordinates only make sense near the owning body
  if (!shell || rec.bodyId !== 'EARTH') {
    try {
      const g = stateToGeodetic(s, t, rec.bodyId);
      out.latDeg = g.lat / DEG;
      out.lonDeg = g.lon / DEG;
      out.altKm = g.alt;
    } catch {
      /* unknown body */
    }
  }
  const provider = graph.provider(rec.id);
  // period around the primary body (its gm and radius): the Earth for satellites unless deep in space, the Moon for LRO
  if (inertial && (rec.bodyId !== 'EARTH' || !shell)) out.periodSec = orbitPeriodSec(graph, rec, inertial, t) ?? undefined;
  if (provider instanceof Sgp4Provider && rec.provider?.type === 'sgp4') {
    out.elementAgeDays = (t - Date.parse(rec.provider.omm.EPOCH.endsWith('Z') ? rec.provider.omm.EPOCH : `${rec.provider.omm.EPOCH}Z`)) / 86_400_000;
  }
  out.phase = provider instanceof CompositeProvider ? provider.segmentAt(t)?.phase ?? rec.phase : rec.phase;
  return out;
}
