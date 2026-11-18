/**
 * The kind folders of the entity tree's bodies (docs/reference.md, Entity tree): under a body the bodies that orbit it sit in
 * folders by what they are (Planets, Dwarf planets, Moons, Asteroids), the way the other objects sit in kind groups. The table
 * is keyed by kind string, so a kind that does not exist in the `EntityKind` union yet (`asteroid`) has its folder ready and
 * is simply empty until bodies of that kind exist. The Sun, a root, is never in a folder; `star` is listed for a star that
 * orbits something.
 */

export interface BodyGroupInfo {
  /** folder title */
  label: string;
  /** folder order under a body: lower first */
  order: number;
}

export const BODY_GROUPS: Readonly<Record<string, BodyGroupInfo>> = {
  star: { label: 'Stars', order: 0 },
  planet: { label: 'Planets', order: 1 },
  dwarf_planet: { label: 'Dwarf planets', order: 2 },
  moon: { label: 'Moons', order: 3 },
  asteroid: { label: 'Asteroids', order: 4 },
};

/** A kind with no entry of its own (a comet, say) is listed after the known ones under its own name. */
export function bodyGroupInfo(kind: string): BodyGroupInfo {
  const known = BODY_GROUPS[kind];
  if (known) return known;
  const words = kind.replace(/_/g, ' ');
  return { label: `${words.charAt(0).toUpperCase()}${words.slice(1)}${kind === 'other' ? ' bodies' : 's'}`, order: 99 };
}

export const bodyGroupLabel = (kind: string): string => bodyGroupInfo(kind).label;
export const bodyGroupOrder = (kind: string): number => bodyGroupInfo(kind).order;

/** What the registry says about a body (`Body` in core): enough to tell its class. */
export interface BodyClassInput {
  id: string;
  parentId?: string;
  dwarf?: boolean;
}

/**
 * The kind of each registry body when no entity says it: a body with no parent is a star, a dwarf one a dwarf planet, one
 * whose parent is a star a planet, anything deeper a moon. An entity's own kind wins where the caller has it (`kindOf`).
 */
export function registryBodyKinds(bodies: readonly BodyClassInput[]): Map<string, string> {
  const byId = new Map(bodies.map((b) => [b.id, b]));
  const out = new Map<string, string>();
  for (const b of bodies) {
    const parent = b.parentId ? byId.get(b.parentId) : undefined;
    if (!parent) out.set(b.id, 'star');
    else if (b.dwarf) out.set(b.id, 'dwarf_planet');
    else out.set(b.id, parent.parentId && byId.has(parent.parentId) ? 'moon' : 'planet');
  }
  return out;
}
