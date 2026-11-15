import { defaultBodies, type BodyRegistry } from '@eio/core';
import { MARKER_BELOW_PX } from './body-style';

/**
 * Scope policy (pure): which objects are worth drawing, by the body HIERARCHY, not by distance. The goal is to draw as much
 * as possible and nothing that cannot help: an object is in scope when the body it is listed under (core `listParent`: the
 * deepest sphere of influence that holds it; `lib/listed-parent.ts`) is the FOCUS BODY or one of its ancestors.
 *
 * The focus body is the system the camera is in (`focusBodyOf`): the followed object's body, or the body it orbits; else the
 * frame's body; the Earth by default. So:
 * - around the Earth (the default view, following the ISS, a pad close-up): every Earth satellite, pad and ground station, and
 *   the objects listed under the Sun (JWST, Voyager, Parker): the whole near-Earth population and the probes in the sky.
 *   LRO (listed under the Moon) and MRO (under Mars) are out: from here they sit on the Moon's or Mars's dot;
 * - at the Moon: LRO, plus the Earth's satellites and the Sun's probes (the ancestors' objects are context, not clutter);
 * - at Mars: MRO and the Mars landers, plus the Sun's probes; the 19,000 Earth objects are out;
 * - at the Sun (a whole Solar System view): only the objects listed under the Sun; every planet's own satellites are out (at
 *   that scale they are inside the planet's dot).
 * The celestial bodies follow the same hierarchy (`bodyInScope`): a body is in scope when the body it orbits is the focus body or
 * an ancestor of it, so the Solar System view keeps the planets and drops every moon's marker, label and pick; the Earth view
 * keeps the Moon and the planets but not Phobos or Io. A body out of scope is still shown once its disc is big enough to see
 * (`bodyShown`): scope only removes the stand-ins (glyph, label, pick area) of a body that is a dot inside its planet's.
 * The caller always keeps the selection, its related objects, the hovered object and (while the search has an only or text
 * term) what the search lets through, bodies and objects alike.
 *
 * It replaced a distance rule (80 camera distances around the camera target, the cloud thinned beyond): that cut the satellites
 * overhead from a pad view and kept the Earth's whole catalogue at Mars as soon as the camera pulled out. Horizon culling stays
 * separate and exact (`lib/occlusion.ts`, the point shader), and so does the hiding of objects over a small far disc
 * (`lib/disc-hide.ts`).
 */

export type ScopeMode = 'auto' | 'all';

/**
 * Registry ids of the bodies whose objects are in scope for `focusBody`: the body and its ancestors up to the Sun
 * (`BodyRegistry.lineage`). An unknown body gives the set with only itself, so its own objects still show.
 */
export function scopeBodies(focusBody: string, registry: BodyRegistry = defaultBodies): ReadonlySet<string> {
  if (!registry.has(focusBody)) return new Set([focusBody]);
  return new Set(registry.lineage(focusBody).map((b) => b.id));
}

export interface ScopeObject {
  /** registry id of the body the object is listed under (`listedParent`) */
  parent: string | undefined;
  /** selected, related, hovered or let through by the search: never culled */
  keep: boolean;
  /** entity kind; celestial bodies (see `SCOPE_EXEMPT_KINDS`) are never scoped out */
  kind?: string;
}

/**
 * Kinds that are exempt from the OBJECT rule (`inScope`): the celestial bodies (stars, planets, moons). They are drawn by the
 * scene itself rather than as points and have their own rule (`bodyInScope`); this keeps a body from being dropped by the
 * object rule should it ever be passed through it.
 */
export const SCOPE_EXEMPT_KINDS: ReadonlySet<string> = new Set(['star', 'planet', 'moon']);

export const isScopeExempt = (kind: string | undefined): boolean => kind !== undefined && SCOPE_EXEMPT_KINDS.has(kind);

/**
 * Is the object inside the scope? `bodies` is `scopeBodies(focus)`. An object with no known parent is kept (nothing says it is
 * unnecessary). `mode: 'all'` keeps everything (horizon and filters still apply elsewhere).
 */
export function inScope(o: ScopeObject, bodies: ReadonlySet<string>, mode: ScopeMode = 'auto'): boolean {
  if (mode === 'all' || o.keep || isScopeExempt(o.kind) || !o.parent) return true;
  return bodies.has(o.parent);
}

/**
 * Is the celestial body `bodyId` in scope? `bodies` is `scopeBodies(focus)`. A root (the Sun), a body the registry does not know,
 * a body in `bodies` (the focus body and its ancestors) and a body whose parent is in `bodies` (the focus's moons, its siblings,
 * the planets) are in; so are kept bodies (selected, related, hovered, let through by the search) and everything with
 * `mode: 'all'`. The rest (another planet's moons) are out.
 */
export function bodyInScope(bodyId: string, bodies: ReadonlySet<string>, keep: boolean, mode: ScopeMode = 'auto', registry: BodyRegistry = defaultBodies): boolean {
  if (mode === 'all' || keep || bodies.has(bodyId) || !registry.has(bodyId)) return true;
  const parent = registry.get(bodyId).parentId;
  return !parent || bodies.has(parent);
}

/**
 * Are a body's glyph, label and pick area shown? Always when it is in scope; out of scope only once its disc is big enough to see
 * (radius at least `MARKER_BELOW_PX`, where the glyph would stop anyway): what is on screen as a disc is never unpickable.
 */
export const bodyShown = (inScope: boolean, discPx: number): boolean => inScope || discPx >= MARKER_BELOW_PX;

/** What `focusBodyOf` needs of an entity. */
export interface FocusCandidate {
  /** registry id when the entity IS a body (`bodyOf`), else undefined */
  body?: string;
  /** registry id of the body it is listed under (`listedParent`) */
  parent: string;
}

/**
 * The body whose system the camera is in, from the most specific camera anchor that exists: the observatory the camera stands at
 * (first-person), the object of a surface view, the followed entity, then the frame centre. An anchor that is a body is its own
 * system; any other entity belongs to the body it is listed under. With none of them: `fallback` (the Earth).
 */
export function focusBodyOf(anchors: readonly (FocusCandidate | undefined)[], fallback = 'EARTH'): string {
  for (const a of anchors) if (a) return a.body ?? a.parent;
  return fallback;
}

/** The HUD's name for the scope: "Earth system", "Mars system", "Solar System" for the Sun, "everything" with Draw everything on. */
export function scopeLabel(focusBody: string, mode: ScopeMode, registry: BodyRegistry = defaultBodies): string {
  if (mode === 'all') return 'everything';
  if (focusBody === 'SUN') return 'Solar System';
  return `${registry.has(focusBody) ? registry.get(focusBody).name : focusBody} system`;
}

/** Pixel-space margin (fraction of the half-extent) beyond the screen edge that still counts as "in view" for the HUD tally. */
export const VIEW_MARGIN = 1.05;

/**
 * Counts for the HUD: what is drawn out of everything known. `total` counts objects with a position; `rendered` those that
 * are in scope, not filtered out, not behind the Earth and inside the view.
 */
export interface ScopeCounts {
  total: number;
  rendered: number;
}

/** Is a clip-space point (x, y, w) inside the view, with a small margin? w <= 0 is behind the camera. */
export function inView(cx: number, cy: number, cw: number, margin = VIEW_MARGIN): boolean {
  return cw > 0 && Math.abs(cx) <= cw * margin && Math.abs(cy) <= cw * margin;
}
