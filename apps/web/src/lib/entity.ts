import type { EntityRecord, Launch } from '@eio/core';

export type ColorKey = NonNullable<NonNullable<EntityRecord['render']>['colorKey']>;

const KIND_COLOR: Record<string, ColorKey> = {
  station: 'station',
  debris: 'debris',
  probe: 'probe',
  launch_vehicle: 'vehicle',
  stage: 'vehicle',
  capsule: 'vehicle',
  ground_station: 'ground',
  pad: 'ground',
  rover: 'rover',
  lander: 'rover',
  drone: 'aircraft',
};

export function colorKeyOf(rec: EntityRecord): ColorKey {
  return rec.render?.colorKey ?? KIND_COLOR[rec.kind] ?? (rec.group === 'starlink' ? 'starlink' : 'satellite');
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
