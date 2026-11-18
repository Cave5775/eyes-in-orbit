/**
 * Sort options of the entity list (docs/reference.md, Entity tree). A sort is applied within each group (the tree's folders
 * and kind groups, the whole list in LIST); the groups themselves keep their order. `default` is the order the list already
 * has (the text ranking, else the notable kinds first, bodies in registry order), so it adds no comparator.
 *
 * Distance is from the CENTRE OF THE FRAME OF REFERENCE, not from the camera: the camera moves every frame and a list that
 * reorders under the cursor cannot be clicked, while the frame changes only when you choose it. Objects with no position on
 * the main thread (the SGP4 catalog lives in the worker) and objects without a radius fall back to the name.
 */

export type SortMode = 'default' | 'name' | 'distance' | 'size';

export const SORT_MODES: readonly { id: SortMode; label: string; hint: string }[] = [
  { id: 'default', label: 'Default', hint: 'The usual order: best match of the search first, else notable objects first' },
  { id: 'name', label: 'Name', hint: 'A to Z' },
  { id: 'distance', label: 'Distance', hint: 'Nearest to the centre of the frame of reference first (objects with no known position by name)' },
  { id: 'size', label: 'Size', hint: 'Largest radius first (objects with no known radius by name)' },
];

export const SORT_KEY = 'eio.listSort';

export function parseSortMode(v: string | null | undefined): SortMode {
  return SORT_MODES.some((m) => m.id === v) ? (v as SortMode) : 'default';
}

export function loadSortMode(): SortMode {
  try {
    return parseSortMode(localStorage.getItem(SORT_KEY));
  } catch {
    return 'default';
  }
}

export function saveSortMode(m: SortMode): void {
  try {
    localStorage.setItem(SORT_KEY, m);
  } catch { /* private window: the choice just is not remembered */ }
}

/** What a sort reads of an object; absent values fall back to the name. */
export interface SortInfo {
  radiusKm?: number;
  /** distance from the centre of the frame, km */
  distanceKm?: number;
}

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' });

const finite = (v: number | undefined): v is number => v !== undefined && Number.isFinite(v);

/**
 * The comparator of a mode over anything with a name, or undefined for `default` (keep the order). Objects with a value come
 * before those without, ties and the valueless go by name, so the order is total and stable.
 */
export function listComparator<T extends { name: string }>(mode: SortMode, info: (item: T) => SortInfo | undefined): ((a: T, b: T) => number) | undefined {
  if (mode === 'default') return undefined;
  if (mode === 'name') return byName;
  const pick = (t: T): number | undefined => {
    const i = info(t);
    return mode === 'distance' ? i?.distanceKm : i?.radiusKm;
  };
  const sign = mode === 'distance' ? 1 : -1; // nearest first, largest first
  return (a, b) => {
    const x = pick(a), y = pick(b);
    if (finite(x) && finite(y)) return x === y ? byName(a, b) : sign * (x - y);
    if (finite(x)) return -1;
    if (finite(y)) return 1;
    return byName(a, b);
  };
}

/** A sorted copy (the input when there is no comparator). */
export function sortedBy<T>(items: readonly T[], cmp: ((a: T, b: T) => number) | undefined): readonly T[] {
  return cmp ? [...items].sort(cmp) : items;
}
