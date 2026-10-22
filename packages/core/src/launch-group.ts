/**
 * Launch groups: objects that share a launch (COSPAR / international designator `YYYY-NNNPPP`,
 * e.g. `1993-036A` is the payload and `1993-036BQ` a piece of the same launch's debris).
 * Pure helpers, no I/O, shared by server and web.
 */

const COSPAR = /^(\d{4})-(\d{3})([A-Z]{0,3})$/;

export interface CosparParts {
  /** `YYYY-NNN`, the launch of the year. */
  launchId: string;
  /** Piece letters (`A`, `BQ`); empty when the designator has none. */
  piece: string;
}

/** Split a COSPAR designator; undefined for anything that is not `YYYY-NNN[A-Z]{0,3}`. */
export function parseCospar(cospar: string | null | undefined): CosparParts | undefined {
  if (typeof cospar !== 'string') return undefined;
  const m = COSPAR.exec(cospar.trim().toUpperCase());
  if (!m) return undefined;
  const year = Number(m[1]);
  const seq = Number(m[2]);
  if (year < 1957 || year > 2100 || seq < 1) return undefined;
  return { launchId: `${m[1]}-${m[2]}`, piece: m[3] };
}

/** `1993-036BQ` -> `1993-036`. Missing or malformed designators give no group (undefined). */
export function launchIdFromCospar(cospar: string | null | undefined): string | undefined {
  return parseCospar(cospar)?.launchId;
}

export interface LaunchGroupMember {
  name: string;
  cospar?: string | null;
}

const DEBRIS_SUFFIX = /\s+(DEB|R\/B)\s*$/i;

/** Object name without a trailing ` DEB` / ` R/B`. */
export function baseObjectName(name: string): string {
  return name.replace(DEBRIS_SUFFIX, '').trim();
}

/**
 * Display label for a launch group. The member whose piece is `A` (usually the payload) wins;
 * otherwise the most common name once ` DEB` / ` R/B` are stripped (ties: shorter, then alphabetical).
 * Falls back to the launch id when no member has a usable name.
 */
export function launchGroupLabel(members: readonly LaunchGroupMember[], launchId?: string): string {
  const id = launchId ?? members.map((m) => launchIdFromCospar(m.cospar)).find(Boolean);
  const primary = members.find((m) => parseCospar(m.cospar)?.piece === 'A' && baseObjectName(m.name));
  if (primary) return baseObjectName(primary.name);
  const counts = new Map<string, number>();
  for (const m of members) {
    const base = baseObjectName(m.name);
    if (base) counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || a[0].localeCompare(b[0]))[0];
  return best ? best[0] : id ?? 'Unknown launch';
}
