import { launchGroupLabel, launchIdFromCospar, type EntityRecord } from '@eio/core';

/** Launch id (`1993-036`) of a record, from its COSPAR alias. */
export const launchIdOf = (rec: { aliases?: Record<string, string> }): string | undefined => launchIdFromCospar(rec.aliases?.cospar);

export interface LaunchGroup {
  /** `YYYY-NNN` */
  id: string;
  /** e.g. "COSMOS 2251" */
  label: string;
  count: number;
  /** Entity ids of the members. */
  ids: string[];
}

/** Groups of objects sharing a launch (>= `minMembers`), largest first. Records without a valid COSPAR are ignored. */
export function buildLaunchGroups(
  records: Iterable<Pick<EntityRecord, 'id' | 'name' | 'aliases'>>,
  minMembers = 2,
): LaunchGroup[] {
  const byLaunch = new Map<string, Pick<EntityRecord, 'id' | 'name' | 'aliases'>[]>();
  for (const r of records) {
    const id = launchIdOf(r);
    if (!id) continue;
    const list = byLaunch.get(id);
    if (list) list.push(r);
    else byLaunch.set(id, [r]);
  }
  const out: LaunchGroup[] = [];
  for (const [id, members] of byLaunch) {
    if (members.length < minMembers) continue;
    out.push({
      id,
      label: launchGroupLabel(members.map((m) => ({ name: m.name, cospar: m.aliases.cospar })), id),
      count: members.length,
      ids: members.map((m) => m.id),
    });
  }
  return out.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

/** Members of the launches a `launch:` tag names (a launch id, or a year: `1993` is every launch of 1993), for the camera fit. */
export function launchMembers(groups: readonly LaunchGroup[], value: string): string[] {
  return groups.filter((g) => g.id === value || g.id.startsWith(`${value}-`)).flatMap((g) => g.ids);
}

/** Search over launch groups by label or launch id; empty query keeps the count order. */
export function searchLaunchGroups(groups: readonly LaunchGroup[], q: string, limit = 50): LaunchGroup[] {
  const query = q.trim().toLowerCase();
  if (!query) return groups.slice(0, limit);
  const scored: { g: LaunchGroup; s: number }[] = [];
  for (const g of groups) {
    const label = g.label.toLowerCase();
    let s = 0;
    if (g.id === query) s = 100;
    else if (label === query) s = 95;
    else if (label.startsWith(query)) s = 80;
    else if (label.split(/[\s\-_()/]+/).some((w) => w.startsWith(query))) s = 60;
    else if (label.includes(query)) s = 40;
    else if (g.id.includes(query)) s = 30;
    if (s) scored.push({ g, s });
  }
  scored.sort((a, b) => b.s - a.s || b.g.count - a.g.count || a.g.label.localeCompare(b.g.label));
  return scored.slice(0, limit).map((x) => x.g);
}
