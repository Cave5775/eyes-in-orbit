/**
 * The hierarchical entity browser (docs/frames.md, UI): entities grouped under their primary body (`bodyId`), the bodies
 * nested like the body tree (SUN > EARTH > MOON, SUN > MARS). Everything here is pure: `buildTreeRows` turns the (already
 * filtered and ordered) entities into the flat list of rows the virtualised list draws, one fixed-height row each, and
 * only the nodes that are open contribute rows, so the cost is one pass over the entities plus the visible rows.
 */

export interface TreeBody {
  id: string;
  name: string;
  parentId?: string;
  /**
   * The entity that stands for this body (`body-moon`), when the caller knows it exists but it may be filtered out of the
   * items: the node carries it as `entityId` unless an item backs the node itself.
   */
  entityId?: string;
}

/** What the tree needs of an entity (a record or a search hit). */
export interface TreeItem {
  id: string;
  kind: string;
  /** the body the entity orbits (for a body entity: its PARENT body) */
  bodyId?: string;
  /** a record with provider type `body` is a body entity: it becomes the node of `provider.bodyId` instead of a row */
  provider?: { type: string; bodyId?: string };
}

export type TreeRow =
  | { type: 'body'; key: string; bodyId: string; name: string; depth: number; count: number; open: boolean; entityId?: string }
  | { type: 'group'; key: string; kind: string; depth: number; count: number; open: boolean }
  | { type: 'entity'; key: string; id: string; depth: number };

export interface TreeOptions<T extends TreeItem> {
  bodies: readonly TreeBody[];
  /** the active frame (an entity id): the path to its body is open by default, and its own row keeps its group open */
  frameId: string;
  /** registry id of the body node that path ends at: the frame's own body (`MOON` for `body-moon`), for an object its primary body (default `EARTH`) */
  frameBodyId?: string;
  /** a query or a filter is active: every node that has a hit is open by default */
  openAll?: boolean;
  /** no filter is active: every body of the registry is a node (count 0 allowed), even with nothing listed under it */
  skeleton?: boolean;
  /** explicit user choices by row key; they win over the defaults */
  overrides?: ReadonlyMap<string, boolean>;
  /** a body with more direct entities than this lists them under kind groups (default 12) */
  groupMin?: number;
  /** display name of a kind, used to order groups alphabetically among equals */
  kindName?: (kind: string) => string;
  /** body of an item when the item itself has no `bodyId` (search hits) */
  bodyOf?: (item: T) => string | undefined;
  /** registry body id an item stands for, for items without a `provider` (search hits of body entities) */
  standsForBody?: (item: T) => string | undefined;
}

export const bodyKey = (id: string): string => `b:${id}`;
export const groupKey = (bodyId: string, kind: string): string => `g:${bodyId}:${kind}`;
export const entityKey = (bodyId: string, id: string): string => `e:${bodyId}:${id}`;

interface Node<T> {
  id: string;
  name: string;
  parent: Node<T> | null;
  children: Node<T>[];
  /** the objects listed under the body (body entities are not among them) */
  items: T[];
  /** objects in the subtree (body entities are nodes, not counted) */
  count: number;
  /** the entity backing this node */
  entityId?: string;
  /** that entity is among the items (it passed the filters / matched the query) */
  backed: boolean;
}

export const DEFAULT_GROUP_MIN = 12;

/** Keys of the body nodes from the root down to `bodyId` (root first). Unknown ids give just their own key. */
export function bodyPathKeys(bodies: readonly TreeBody[], bodyId: string): string[] {
  const byId = new Map(bodies.map((b) => [b.id, b]));
  const out: string[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = bodyId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    out.push(bodyKey(cur));
    cur = byId.get(cur)?.parentId;
  }
  return out.reverse();
}

export function buildTreeRows<T extends TreeItem>(items: readonly T[], opts: TreeOptions<T>): TreeRow[] {
  const groupMin = opts.groupMin ?? DEFAULT_GROUP_MIN;
  const overrides = opts.overrides;
  const kindName = opts.kindName ?? ((k: string) => k);

  // nodes in registry order, linked to their parents
  const nodes = new Map<string, Node<T>>();
  for (const b of opts.bodies) nodes.set(b.id, { id: b.id, name: b.name, parent: null, children: [], items: [], count: 0, entityId: b.entityId, backed: false });
  const roots: Node<T>[] = [];
  for (const b of opts.bodies) {
    const n = nodes.get(b.id)!;
    const p = b.parentId ? nodes.get(b.parentId) : undefined;
    if (p) {
      n.parent = p;
      p.children.push(n);
    } else roots.push(n);
  }

  // a body the registry does not know hangs off the first root
  const nodeFor = (bid: string): Node<T> => {
    let n = nodes.get(bid);
    if (!n) {
      n = { id: bid, name: bid, parent: roots[0] ?? null, children: [], items: [], count: 0, backed: false };
      nodes.set(bid, n);
      if (roots[0]) roots[0].children.push(n);
      else roots.push(n);
    }
    return n;
  };

  // one pass over the entities: a body entity backs its body's node, everything else is listed under the body it orbits
  for (const it of items) {
    const own = it.provider?.type === 'body' ? it.provider.bodyId : opts.standsForBody?.(it);
    if (own) {
      const n = nodeFor(own);
      n.entityId = it.id;
      n.backed = true;
      continue;
    }
    nodeFor(it.bodyId ?? opts.bodyOf?.(it) ?? 'EARTH').items.push(it);
  }

  const count = (n: Node<T>): number => {
    n.count = n.items.length;
    for (const c of n.children) n.count += count(c);
    return n.count;
  };
  for (const r of roots) count(r);
  // a node is shown when something is listed under it or an entity that passed the filters backs it (or a sub-body)
  const shown = new Map<Node<T>, boolean>();
  const isShown = (n: Node<T>): boolean => {
    let s = shown.get(n);
    if (s === undefined) {
      s = !!opts.skeleton || n.count > 0 || n.backed || n.children.some(isShown);
      shown.set(n, s);
    }
    return s;
  };

  // open by default: the path to the frame (and its own node), and everything with a hit while filtering
  const auto = new Set<string>();
  for (const k of bodyPathKeys(opts.bodies, opts.frameBodyId ?? 'EARTH')) auto.add(k);
  const frameEntity = opts.frameId;
  const isOpen = (key: string): boolean => {
    const o = overrides?.get(key);
    if (o !== undefined) return o;
    return !!opts.openAll || auto.has(key);
  };

  const rows: TreeRow[] = [];
  const emit = (n: Node<T>, depth: number): void => {
    if (!isShown(n)) return;
    const key = bodyKey(n.id);
    const open = isOpen(key);
    const row: TreeRow = { type: 'body', key, bodyId: n.id, name: n.name, depth, count: n.count, open };
    if (n.entityId) row.entityId = n.entityId;
    rows.push(row);
    if (!open) return;
    for (const c of n.children) emit(c, depth + 1);
    if (n.items.length === 0) return;
    if (n.items.length <= groupMin) {
      for (const it of n.items) rows.push({ type: 'entity', key: entityKey(n.id, it.id), id: it.id, depth: depth + 1 });
      return;
    }
    const byKind = new Map<string, T[]>();
    for (const it of n.items) {
      const l = byKind.get(it.kind);
      if (l) l.push(it);
      else byKind.set(it.kind, [it]);
    }
    const kinds = [...byKind.entries()].sort((a, b) => b[1].length - a[1].length || kindName(a[0]).localeCompare(kindName(b[0])));
    for (const [kind, list] of kinds) {
      const gkey = groupKey(n.id, kind);
      // the frame's own entity keeps its group open so it can be seen
      const gopen = isOpen(gkey) || (!overrides?.has(gkey) && list.some((it) => it.id === frameEntity));
      rows.push({ type: 'group', key: gkey, kind, depth: depth + 1, count: list.length, open: gopen });
      if (gopen) for (const it of list) rows.push({ type: 'entity', key: entityKey(n.id, it.id), id: it.id, depth: depth + 2 });
    }
  };
  for (const r of roots) emit(r, 0);
  return rows;
}

// ---------------------------------------------------------------- reveal (selection -> open the path, scroll to the row)

export interface RevealOptions<T extends TreeItem> {
  bodies: readonly TreeBody[];
  /** same meaning as in `TreeOptions`: a body is where `buildTreeRows` would list the item */
  groupMin?: number;
  bodyOf?: (item: T) => string | undefined;
  standsForBody?: (item: T) => string | undefined;
}

/**
 * The node keys to open so that the row of `item` is in the flattened list: the chain of body nodes from the root down to the
 * body it is listed under, plus the kind group it sits in (a group key is harmless when the body is not grouped). A body
 * entity is a node itself: only the nodes above it are opened. Opening is additive; the caller only sets these keys to open.
 */
export function revealKeys<T extends TreeItem>(item: T, opts: RevealOptions<T>): string[] {
  const own = item.provider?.type === 'body' ? item.provider.bodyId : opts.standsForBody?.(item);
  if (own) return bodyPathKeys(opts.bodies, own).slice(0, -1);
  const bodyId = item.bodyId ?? opts.bodyOf?.(item) ?? 'EARTH';
  const known = opts.bodies.some((b) => b.id === bodyId);
  // a body the registry does not know hangs off the first root (as in buildTreeRows)
  const root = opts.bodies.find((b) => !b.parentId || !opts.bodies.some((p) => p.id === b.parentId));
  const path = known || !root ? bodyPathKeys(opts.bodies, bodyId) : [...bodyPathKeys(opts.bodies, root.id), bodyKey(bodyId)];
  return [...path, groupKey(bodyId, item.kind)];
}

/** Index of the row that shows entity `id` (an entity row, or the body node that entity backs), or -1. */
export function revealRowIndex(rows: readonly TreeRow[], id: string): number {
  return rows.findIndex((r) => (r.type === 'entity' && r.id === id) || (r.type === 'body' && r.entityId === id));
}

/**
 * The scrollTop that puts row `index` in the middle of the part of the viewport that is not covered by `pinned` px of sticky
 * rows at the top, clamped to the scrollable range.
 */
export function centredScrollTop(index: number, rowHeight: number, viewHeight: number, count: number, pinned = 0): number {
  const max = Math.max(0, count * rowHeight - viewHeight);
  return Math.min(max, Math.max(0, Math.round(index * rowHeight - pinned - (viewHeight - pinned - rowHeight) / 2)));
}

/**
 * The scrollTop that brings row `index` into view in a fixed-row-height list: null when the row is already fully visible (no
 * movement), else the row centred in the viewport, clamped to the scrollable range. `pinned` is the height in px of the sticky
 * rows laid over the top of the viewport: a row under them is not visible.
 */
export function scrollTopToReveal(
  index: number, rowHeight: number, scrollTop: number, viewHeight: number, count: number, pinned = 0,
): number | null {
  if (index < 0 || index >= count) return null;
  const top = index * rowHeight;
  if (top >= scrollTop + pinned && top + rowHeight <= scrollTop + viewHeight) return null;
  return centredScrollTop(index, rowHeight, viewHeight, count, pinned);
}

// ---------------------------------------------------------------- sticky ancestors (the chain of the first visible row)

/**
 * The rows to pin at the top of the list while the row `first` is the first one in view: its ancestors in the tree (the body
 * nodes down to its body and the kind group it sits in), as indices into `rows`, outermost first (SUN, EARTH, the group). The
 * row itself is not among them, and a top-level row has none. The flattened rows are in depth order, so the ancestors are found
 * by walking back from `first` and taking each row that is shallower than every row taken so far: at most one step per
 * row between the first row and its outermost ancestor, and no allocation beyond the (short) result.
 */
export function stickyAncestors(rows: readonly TreeRow[], first: number): number[] {
  if (rows.length === 0 || first <= 0) return [];
  const at = Math.min(first, rows.length - 1);
  let depth = rows[at].depth;
  const out: number[] = [];
  for (let i = at - 1; i >= 0 && depth > 0; i--) {
    if (rows[i].depth < depth) {
      out.push(i);
      depth = rows[i].depth;
    }
  }
  return out.reverse();
}
