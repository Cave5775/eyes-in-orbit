import { Clock, EntityGraph, type EntityRecord } from '@eio/core';

/** Shared simulation clock: live / paused / scrubbed. Everything evaluates providers at `clock.now()`. */
export const clock = new Clock();

/**
 * Main-thread providers for non-SGP4 entities (and the selected SGP4 entity).
 * Bulk SGP4 propagation lives in the worker, so the catalog is not mirrored here.
 */
export const graph = new EntityGraph();

/** Make sure the record has a live provider on the main thread (the scene does this too; panels must not race it). */
export function ensureInGraph(rec: EntityRecord): void {
  if (graph.get(rec.id) !== rec) graph.upsert(rec);
}
