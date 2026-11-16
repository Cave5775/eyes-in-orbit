import { archiveAnswer, parseMast, planArchiveAsk, type ArchiveImagesResult, type EntityRecord } from '@eio/core';
import hstJupiter from './fixtures/mast-caom-hst-jupiter.json?raw';
import jwstJupiter from './fixtures/mast-caom-jwst-jupiter.json?raw';

/**
 * Offline stand-in for `GET /api/archive-images`. The routing (which archive, which target name, unsupported) is the server's own
 * (core `planArchiveAsk`); the images are trimmed real MAST answers for Jupiter (HST and JWST, the same files as the server tests),
 * run through the server's own parsing and selection. Any other body gets an honest "none": the mock holds no other responses.
 */
const RAW: Record<string, string> = { HST: hstJupiter, JWST: jwstJupiter };

export function mockArchiveImages(obs: Pick<EntityRecord, 'id' | 'name' | 'aliases'>, bodyId: string, nowMs = Date.now()): ArchiveImagesResult {
  const plan = planArchiveAsk(obs, bodyId, nowMs);
  if ('done' in plan) return plan.done;
  const { spec, collection, target, base } = plan.ask;
  if (target !== 'JUPITER') return { ...base, status: 'none', reason: `Mock mode holds MAST responses for Jupiter only (${spec.label}).` };
  return archiveAnswer(base, spec, target, parseMast(RAW[collection]));
}
