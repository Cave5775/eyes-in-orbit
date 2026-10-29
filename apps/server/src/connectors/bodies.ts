import { bodyEntityRecords } from '@eio/core';
import type { Connector, ConnectorContext } from '../connector';

function sync(ctx: ConnectorContext): number {
  const recs = bodyEntityRecords(undefined, Date.now());
  ctx.hub.upsert(...recs);
  ctx.health.note = `${recs.length} bodies`;
  return recs.length;
}

/**
 * The body registry (35 bodies: Sun, planets, dwarf planets, major moons) as entities with a `body` provider, so bodies are searchable, selectable and
 * have trajectories like any other object. Offline, no polling: registered once at startup (before the first request is
 * served) and a single `run` marks the connector healthy. `/api/bodies` still serves the raw registry.
 */
export const bodies: Connector = {
  id: 'bodies',
  network: false,
  start: (ctx) => void sync(ctx),
  async run(ctx) {
    sync(ctx);
  },
};
