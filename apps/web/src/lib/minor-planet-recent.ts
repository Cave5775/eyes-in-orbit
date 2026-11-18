/**
 * The lightweight entities made for picked minor planets (scene/minor-planets.ts `minorPlanetRecord`) are kept few: the one just picked
 * (it becomes the selection), the last `KEEP_PICKED` before it and whatever is selected now. `recent` is most recent first.
 * Returns the new list and the ids to remove from the catalogue.
 */
export const KEEP_PICKED = 4;

export function rememberPicked(recent: readonly string[], id: string, selectedId: string | null, keep = KEEP_PICKED): { recent: string[]; evict: string[] } {
  const all = [id, ...recent.filter((x) => x !== id)];
  const kept = all.slice(0, keep + 1);
  const evict: string[] = [];
  for (const x of all.slice(keep + 1)) {
    if (x === selectedId) kept.push(x); // never the selection
    else evict.push(x);
  }
  return { recent: kept, evict };
}
