/**
 * Skins: the look of the interface, one `data-skin` attribute on the root element (`<html>`). Each skin is a set of
 * token overrides in `skins.css` (colours, type, radii, shadows, a few decorative touches), so no component knows which
 * skin is active. `classic` is the stylesheet's own defaults. The choice is remembered in `localStorage['eio.skin']`;
 * anything unknown, and blocked storage, reads as `classic`.
 */
export const SKINS = [
  { id: 'classic', label: 'Classic', hint: 'Graphite and ink, the original look' },
  { id: 'terminal', label: 'Terminal', hint: 'Monospace on black, amber cursor, square corners, no shadows' },
  { id: 'mission', label: 'Mission 1960s', hint: 'Navy and cream control console: chamfered panels, screws, nixie clock, lamp-lit keys, CRT scene' },
] as const;

export type SkinId = (typeof SKINS)[number]['id'];

export const DEFAULT_SKIN: SkinId = 'classic';
export const SKIN_KEY = 'eio.skin';
export const SKIN_ATTR = 'data-skin';

const IDS: ReadonlySet<string> = new Set(SKINS.map((s) => s.id));

/** The skin a stored value names; null, undefined or anything unknown is the default. */
export function parseSkin(raw: unknown): SkinId {
  return typeof raw === 'string' && IDS.has(raw) ? (raw as SkinId) : DEFAULT_SKIN;
}

/** The text stored for a skin (the id itself); the default is stored too, so a later default change cannot move a user. */
export function serialiseSkin(id: SkinId): string {
  return id;
}
