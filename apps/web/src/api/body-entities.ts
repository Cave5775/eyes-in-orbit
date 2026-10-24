import { bodyEntityRecords, type EntityRecord } from '@eio/core';

/**
 * The entity list plus any body entity (Sun, Earth, Mars, Moon) it lacks, built locally from the body registry. The
 * server's `bodies` connector normally supplies them; this keeps the UI complete when that connector is disabled or the
 * server is older. Records the server sent win; the input array is not modified.
 */
export function withBodyEntities(records: EntityRecord[], updatedAt = Date.now()): EntityRecord[] {
  const have = new Set(records.map((r) => r.id));
  const missing = bodyEntityRecords(undefined, updatedAt).filter((b) => !have.has(b.id));
  return missing.length ? [...records, ...missing] : records;
}
