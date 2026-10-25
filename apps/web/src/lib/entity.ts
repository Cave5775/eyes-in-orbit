import type { EntityRecord, Launch } from '@eio/core';
import { categoryOf, type CategoryId } from './browser-ui';

/**
 * The colour key of an entity is its browser category (`categoryOf`, lib/browser-ui.ts): the nine general categories are the
 * only colours, in the scene, the lists, the legend and the labels (`--c-<category>` in styles.css, `scene/palette.ts`).
 * `render.colorKey` from a feed is advisory: `categoryOf` reads it as a hint when the kind does not decide, and the old
 * `starlink` key just means a satellite.
 */
export type ColorKey = CategoryId;

export function colorKeyOf(rec: Pick<EntityRecord, 'kind' | 'group' | 'render'>): ColorKey {
  return categoryOf(rec);
}

export const isSgp4 = (rec: EntityRecord): boolean => rec.provider?.type === 'sgp4';

export const isIss = (rec: EntityRecord | undefined): boolean =>
  !!rec && (rec.aliases.norad === '25544' || rec.id === 'sat-25544');

export function launchOf(rec: EntityRecord | undefined, launches: Launch[]): Launch | undefined {
  if (!rec) return undefined;
  return launches.find((l) => l.entityId === rec.id || l.id === rec.links?.launchId);
}

/** Entity id for a DSN spacecraft code. */
export const dsnEntityId = (code: string): string => `dsn-${code}`;

export function kindLabel(kind: string): string {
  return kind.replace(/_/g, ' ');
}
