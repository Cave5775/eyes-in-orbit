import { GROUND_OBSERVATORIES, OBSERVATORY_GROUP, observatoryAttrs, type GroundObservatory } from '@eio/core';
import type { Connector } from '../connector';
import type { NewEntity } from '../hub';

export function groundObservatoryEntity(o: GroundObservatory): NewEntity {
  return {
    id: o.id, name: o.name, kind: 'ground_station', bodyId: 'EARTH', aliases: { observatory: o.id.slice(4) }, group: OBSERVATORY_GROUP,
    provider: { type: 'geodetic', bodyId: 'EARTH', latDeg: o.latDeg, lonDeg: o.lonDeg, altKm: o.altKm },
    links: { newsQuery: o.name },
    render: { colorKey: 'ground', glyph: 'square', label: true },
    attrs: observatoryAttrs(o.meta),
  };
}

/** Static ground observatories (no network). */
export const observatories: Connector = {
  id: 'observatories',
  network: false,
  start(ctx) {
    ctx.hub.upsert(...GROUND_OBSERVATORIES.map(groundObservatoryEntity));
    ctx.health.note = `${GROUND_OBSERVATORIES.length} ground sites`;
  },
  async run() {
    // nothing to poll: one run marks the connector healthy
  },
};
