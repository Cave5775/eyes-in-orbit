import { bodyEntityId, bodyOf, defaultBodies, type EntityRecord } from '@eio/core';
import { listedParent } from '../lib/listed-parent';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { BODY_CATEGORY_KINDS, CATEGORIES, categoryCounts, categoryLabel } from '../lib/browser-ui';
import { buildTreeRows, revealKeys, revealRowIndex, stickyAncestors, type BodyGroups, type TreeBody } from '../lib/entity-tree';
import { bodyGroupLabel, bodyGroupOrder, registryBodyKinds } from '../lib/body-groups';
import { listComparator, loadSortMode, saveSortMode, SORT_MODES, parseSortMode, type SortInfo, type SortMode } from '../lib/list-sort';
import { colorKeyOf, kindLabel } from '../lib/entity';
import { browseOrder, facetCounts, searchHitOf, type SearchHit } from '../lib/filters';
import { afterPick, isSearching, moveHighlight, pendingQuery, pickedResult, searchRows, searchTagTerms, searchTextOf } from '../lib/search-pending';
import { typeOf } from '../lib/view-class';
import { centreStateEci, graphLookup, isEarthCentre } from '../lib/frame';
import { buildLaunchGroups, launchMembers } from '../lib/launch-group';
import {
  NO_FOCUS, findTerm, hasHide, isDrawn, classify, queryActive, tagTerms, termFromWord, termWord, textOf, type Ctx, type Query, type Term,
} from '../lib/query';
import {
  acceptTag, activeTag, backspaceRemovesChip, suggestTags, type TagKey, type TagSuggestion,
} from '../lib/search-tags';
import { perf } from '../lib/perf';
import { focusesSearch } from '../lib/focus-search';
import { skyCoversScene } from '../lib/sky-mode';
import { clock, ensureInGraph, graph, runtime } from '../state/runtime';
import { useStore } from '../state/store';
import { useView } from '../state/view';
import { VirtualList, type VirtualListHandle } from './VirtualList';

const ROW_H = 28;
const DEBOUNCE_MS = 250;
const INDENT_PX = 12;

/** The body tree the entity tree nests under (SUN > EARTH > MOON, SUN > MARS). */
const REGISTRY_KINDS = registryBodyKinds(defaultBodies.all());
const TREE_BODIES: TreeBody[] = defaultBodies.all().map((b) => ({ id: b.id, name: b.name, parentId: b.parentId, kind: REGISTRY_KINDS.get(b.id), radiusKm: b.radiusKm }));
/** the bodies that orbit a body sit in folders by kind (Planets, Dwarf planets, Moons, Asteroids; lib/body-groups.ts) */
const BODY_GROUPS_OPT: BodyGroups = { of: (b) => b.kind ?? 'other', label: bodyGroupLabel, order: bodyGroupOrder };

/** Eye: the group is shown (click to hide it); crossed: it is hidden (click to show it). */
function Eye({ off }: { off: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M1 8s2.6-4.5 7-4.5S15 8 15 8s-2.6 4.5-7 4.5S1 8 1 8z" />
      <circle cx="8" cy="8" r="2" />
      {off && <path d="M2.5 13.5l11-11" />}
    </svg>
  );
}

const HELP_TAGS: [string, string][] = [
  ['#starlink  group:gps-ops', 'a CelesTrak group'],
  ['type:probe', 'what it is: a category (the chips above) or a kind (satellite, launch_vehicle, ground_station, moon...). Orbiters of other bodies (MRO, LRO) are satellites; probe is only what is in solar orbit or leaving'],
  ['launch:2024-123', 'one launch (launch:1993 is a year)'],
  ['type:navigation', 'a whole category (probes also holds rovers and landers)'],
  ['id:25544', 'a NORAD, COSPAR or entity id'],
  ['body:moon', 'what orbits that body'],
  ['-type:debris', 'a leading - leaves those out'],
];

/** Whether the query lists a row: the predicate the search list, the tree and the scene share (the search list gets the pending query). */
const listedBy = (entities: ReadonlyMap<string, EntityRecord>, query: Query, text: ReadonlySet<string> | null) => {
  const ctx: Ctx = { focus: NO_FOCUS, text };
  return (r: SearchHit) => isDrawn(classify(entities.get(r.id) ?? r, query, ctx));
};

export function EntityBrowser() {
  const entities = useStore((s) => s.entities);
  // the lists rebuild when the catalogue's shape changes (records added, renamed ...), not on every merge: a push of new SGP4
  // elements leaves them as they are (state/store.ts `catalogShape`; the records they read are the current ones either way)
  const shape = useStore((s) => s.catalogShape);
  const query = useStore((s) => s.query);
  const textHits = useStore((s) => s.textHits);
  const textIds = useStore((s) => s.textIds);
  const searchHits = useStore((s) => s.searchHits);
  const searchIds = useStore((s) => s.searchIds);
  const selectedId = useStore((s) => s.selectedId);
  const frame = useStore((s) => s.frame);
  const { setQuery, setSearchText, removeTerm, toggleTerm, setTermEffect, clearQuery, showAll, selectObject } = useStore.getState();
  /** what is typed (a search: free text and tag words; nothing is applied until Filter). The applied query's terms are the chips. */
  const [input, setInput] = useState('');
  /** the highlighted search result (-1: none) */
  const [hi, setHi] = useState(-1);
  const searching = isSearching(input);
  const [sort, setSortState] = useState<SortMode>(loadSortMode);
  const setSort = (m: SortMode) => {
    setSortState(m);
    saveSortMode(m);
  };
  const [help, setHelp] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  /** bumped when the main-thread graph gained the records a distance sort reads, so the sort is taken again */
  const [graphTick, setGraphTick] = useState(0);
  /** explicit open / closed choices of tree nodes by row key; they win over the defaults (see buildTreeRows) */
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  /** the node just collapsed: its row stays in view (a pinned header that is collapsed would otherwise scroll away) */
  const collapsedKey = useRef<string | null>(null);
  const setOpen = useCallback((key: string, open: boolean) => {
    if (!open) collapsedKey.current = key;
    setOverrides((o) => new Map(o).set(key, open));
  }, []);
  /** what the query restricts (its only terms and the text): a change of it starts from the defaults again; hiding a group does not */
  const filterKey = useMemo(() => query.terms.filter((t) => t.effect === 'only').map(termWord).join('\n'), [query]);
  const filtering = queryActive(query);
  // a new query starts from the defaults again (everything with a hit open)
  useEffect(() => setOverrides((o) => (o.size ? new Map() : o)), [filterKey]);
  // reveal: a selection that did not come from a click in this browser opens the path to its row and scrolls to it
  const listRef = useRef<VirtualListHandle>(null);
  /** the id a row click here just selected: the effect below skips it, so the list never moves under the cursor */
  const ownSelect = useRef<string | null>(null);
  /** the entity whose row is still to be scrolled to once the expansion has reached the list */
  const [revealId, setRevealId] = useState<string | null>(null);

  // Enter (nothing else wants it: not in a field, a row, a button or a link; not in the Sky view) goes to the search field
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const panel = panelRef.current;
      const ctx = {
        skyCovers: skyCoversScene(useView.getState().sky.phase),
        // the panel is not on screen, or a popover / menu / dialog (Settings, View, Data streams, scene help, the pick list) is open
        panelHidden: !panel || panel.getClientRects().length === 0,
        popoverOpen: !!document.querySelector('.popover, [aria-modal="true"]'),
      };
      if (!focusesSearch(e, ctx)) return;
      e.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // the typed text is looked up for the search list (never the scene). Typing is debounced; a cleared text goes at once.
  const typed = searchTextOf(input);
  useEffect(() => {
    if (!typed) {
      setSearchText('');
      return;
    }
    const h = setTimeout(() => setSearchText(typed), DEBOUNCE_MS);
    return () => clearTimeout(h);
  }, [typed, setSearchText]);
  useEffect(() => setHi(-1), [input]);

  const facets = useMemo(() => facetCounts(entities.values()), [shape]);
  const categories = useMemo(() => categoryCounts(entities.values()), [shape]);
  const launchGroups = useMemo(() => buildLaunchGroups(entities.values()), [shape]);

  // autocomplete for `group:` / `#`, `type:`, `launch:`, `body:`
  const sources = useMemo((): Record<TagKey, TagSuggestion[]> => {
    const bodies = new Map<string, number>();
    for (const e of entities.values()) bodies.set(e.bodyId.toLowerCase(), (bodies.get(e.bodyId.toLowerCase()) ?? 0) + 1);
    return {
      group: facets.groups.map(([value, count]) => ({ value: value.toLowerCase(), count })),
      // the nine categories first, then the kinds (a kind named like a category, `debris`, is the category)
      type: [
        ...categories.map(([id, count]): TagSuggestion => ({ value: id, label: categoryLabel(id), count, first: true })),
        ...facets.kinds.map(([value, count]): TagSuggestion => ({ value: value.toLowerCase(), count })).filter((s) => !CATEGORIES.some((c) => c.id === s.value)),
      ],
      launch: launchGroups.map((g) => ({ value: g.id, label: g.label, count: g.count })),
      body: [...bodies].map(([value, count]) => ({ value, count })),
      id: [],
    };
  }, [shape, facets, categories, launchGroups]);
  const active = useMemo(() => activeTag(input), [input]);
  const suggestions = useMemo(() => (active ? suggestTags(active, sources[active.key]) : []), [active, sources]);
  const suggestOpen = focused && !dismissed && suggestions.length > 0;
  const cur = Math.min(sel, Math.max(0, suggestions.length - 1));

  // the rows: what the query lets through (the same predicate the scene draws by, so the counts match what is drawn). Hidden
  // groups are not listed. The text ranks them; without text the notable kinds come first.
  const ordered = useMemo(() => [...entities.values()].sort(browseOrder).map(searchHitOf), [shape]);
  const rows: SearchHit[] = useMemo(() => {
    const t0 = perf.on ? performance.now() : 0;
    const out = searchRows(ordered, textHits, textOf(query), listedBy(entities, query, textIds));
    if (perf.on) perf.time('rows', performance.now() - t0);
    return out;
  }, [shape, ordered, query, textHits, textIds]);
  /** the search results: the same predicate over the pending query (the applied one plus what is typed), ranked by the typed text */
  const searchResults: SearchHit[] = useMemo(
    () => (searching ? searchRows(ordered, searchHits, typed, listedBy(entities, pendingQuery(query, input), searchIds)) : []),
    [searching, shape, ordered, query, input, typed, searchHits, searchIds],
  );

  /**
   * The sort of the lists, inside each group. Distance is from the centre of the frame at the time the sort, the frame or the
   * catalogue's shape last changed (the list does not reshuffle while the clock runs); it is only known for objects the main
   * thread can place (the bodies, the selection), the rest fall back to the name (lib/list-sort.ts).
   */
  const sorters = useMemo(() => {
    const t = clock.now();
    const lookup = graphLookup(graph);
    const cache = new Map<string, SortInfo>();
    // the centre's state is read once per pass, not once per object (null until the graph holds the frame's record: see the effect below)
    const centre = sort === 'distance' ? centreStateEci(frame, t, lookup) : null;
    const infoOf = (id: string): SortInfo => {
      let i = cache.get(id);
      if (i) return i;
      const rec = entities.get(id);
      const radius = rec?.attrs?.radiusKm;
      i = { radiusKm: typeof radius === 'number' ? radius : undefined };
      if (centre && rec) {
        const s = lookup(id, t);
        if (s) i.distanceKm = Math.hypot(s.r[0] - centre.r[0], s.r[1] - centre.r[1], s.r[2] - centre.r[2]);
      }
      cache.set(id, i);
      return i;
    };
    return {
      item: listComparator<{ id: string; name: string }>(sort, (r) => infoOf(r.id)),
      body: listComparator<TreeBody>(sort, (b) => {
        const i = b.entityId ? infoOf(b.entityId) : {};
        return { ...i, radiusKm: i.radiusKm ?? b.radiusKm };
      }),
    };
  }, [sort, frame, shape, graphTick]);
  /** the rows in the chosen order, sorted once per change of the rows, the sort or the frame (the tree groups them in this order) */
  const listRows = useMemo(() => (sorters.item ? [...rows].sort(sorters.item) : rows), [rows, sorters]);
  /** the search results in the chosen order */
  const searchList = useMemo(() => (sorters.item ? [...searchResults].sort(sorters.item) : searchResults), [searchResults, sorters]);

  // the tree: the same filtered, ordered rows, nested under their primary body and flattened to the rows that are open
  const pick = (id: string) => {
    ownSelect.current = id;
    selectObject(id);
  };

  /** the registry bodies as tree nodes: with their entity (so a node can select it even when a filter hides its row) and its kind */
  const treeBodies = useMemo(() => TREE_BODIES.map((b): TreeBody => {
    const entityId = bodyEntityId(b.id);
    const rec = entities.get(entityId);
    return rec ? { ...b, entityId, kind: rec.kind || b.kind } : b;
  }), [shape]);

  // a distance sort needs the frame's record and the body entities in the main-thread graph (the scene adds them too): add what is
  // missing here, outside the memo, and take the sort again. A frame locked to an object whose record arrives later is caught by `shape`.
  useEffect(() => {
    if (sort !== 'distance') return;
    let added = false;
    const ensure = (rec: EntityRecord | undefined) => {
      if (rec?.provider && graph.get(rec.id) !== rec) {
        ensureInGraph(rec);
        added = true;
      }
    };
    ensure(entities.get(frame));
    for (const b of treeBodies) if (b.entityId) ensure(entities.get(b.entityId));
    if (added) setGraphTick((n) => n + 1);
  }, [sort, frame, shape, treeBodies]);

  const treeRows = useMemo(() => {
    if (searching) return []; // the search list is showing
    const bodies = treeBodies;
    const recOf = (r: { id: string }) => entities.get(r.id);
    const frameRec = entities.get(frame);
    const t0 = perf.on ? performance.now() : 0;
    const built = buildTreeRows(listRows, {
      bodies, frameId: frame, frameBodyId: frameRec ? bodyOf(frameRec) ?? frameRec.bodyId : undefined,
      openAll: filtering, skeleton: !filtering, overrides, kindName: kindLabel, bodyOf: (r) => { const e = recOf(r); return e && listedParent(e); },
      standsForBody: (r) => { const p = recOf(r)?.provider; return p?.type === 'body' ? p.bodyId : undefined; },
      bodyGroups: BODY_GROUPS_OPT, sortBodies: sorters.body,
    });
    if (perf.on) perf.time('tree', performance.now() - t0);
    return built;
  }, [searching, listRows, shape, frame, filtering, overrides, treeBodies, sorters]);

  /** the rows pinned at the top of the tree while a row is the first in view: its ancestors (the body chain and the kind group) */
  const stickyOf = useCallback((first: number) => stickyAncestors(treeRows, first), [treeRows]);

  // a body node: opens, and selects its body entity like any other row (the detail panel shows the body, it becomes the
  // frame unless the frame is locked, and the camera flies there)
  const chooseBody = (key: string, entityId?: string) => {
    setOpen(key, true);
    if (entityId) pick(entityId);
  };

  /** open the path to the entity's row in the tree and scroll to it (nothing when the applied filter leaves it out) */
  const revealEntity = (id: string | null) => {
    const rec = id ? entities.get(id) : undefined;
    // a filter that leaves the entity out is never cleared: then there is nothing to reveal and the tree stays as it is
    if (!rec || !rows.some((r) => r.id === rec.id)) {
      setRevealId(null);
      return;
    }
    const keys = revealKeys({ ...rec, kind: typeOf(rec) }, { bodies: treeBodies, bodyOf: (r) => listedParent(r as EntityRecord), bodyGroups: BODY_GROUPS_OPT });
    setOverrides((o) => (keys.every((k) => o.get(k) === true) ? o : new Map([...o, ...keys.map((k): [string, boolean] => [k, true])])));
    setRevealId(rec.id);
  };
  useEffect(() => {
    const own = ownSelect.current === selectedId;
    ownSelect.current = null;
    revealEntity(selectedId && !own ? selectedId : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a change of the selection reveals
  }, [selectedId]);

  useEffect(() => {
    if (revealId === null) return;
    const i = revealRowIndex(treeRows, revealId);
    if (i < 0) return; // the expansion has not reached the tree yet (or the search list is showing)
    listRef.current?.reveal(i);
    setRevealId(null);
  }, [revealId, treeRows]);
  useEffect(() => setRevealId(null), [filterKey]);
  // collapsing a node (a pinned header too) shrinks the list under the scroll position: keep the node's own row in view
  useEffect(() => {
    const key = collapsedKey.current;
    if (key === null || searching) return;
    collapsedKey.current = null;
    const i = treeRows.findIndex((r) => r.key === key);
    if (i >= 0) listRef.current?.reveal(i);
  }, [treeRows, searching]);

  // ---------------------------------------------------------------- the search field: chips (terms), text, autocomplete

  /** the applied filter: the tag terms and the text, one chip each (the field itself holds the search being typed) */
  const chips = useMemo(() => [...tagTerms(query), ...query.terms.filter((t) => t.key === 'text')], [query]);
  const onInput = (v: string) => {
    setDismissed(false);
    setSel(0);
    setInput(v);
  };
  /** an accepted suggestion becomes a finished tag word in the field (part of the search until Filter applies it) */
  const accept = (s: TagSuggestion) => {
    if (!active) return;
    const { chip, rest } = acceptTag(input, active, s.value);
    setInput(`${rest ? `${rest} ` : ''}${chip} `);
    setDismissed(false);
    setSel(0);
    inputRef.current?.focus();
  };
  /** the search is over: the field is empty and the list gives way to the tree */
  const endSearch = () => {
    setInput('');
    setSearchText('');
  };
  /** FILTER: what is typed becomes the applied query (the tree and the scene filter by it, the chips show it); a launch fits the camera to its members */
  const applyFilter = () => {
    if (!searching) return;
    setQuery(pendingQuery(useStore.getState().query, input));
    for (const t of searchTagTerms(input)) if (t.key === 'launch' && !t.neg) {
      const ids = launchMembers(launchGroups, t.value);
      if (ids.length) runtime.onFitRequest?.(ids);
    }
    endSearch();
  };
  /** a click or Enter on a search result: select it (the one way to select), then what afterPick() says */
  const pickResult = (id: string) => {
    selectObject(id);
    if (afterPick().clearField) {
      endSearch();
      revealEntity(id); // the tree comes back with the pick's path open (also when it was selected already)
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && e.nativeEvent.isComposing) return; // the Enter that confirms an IME candidate is not ours
    if (suggestOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setSel((cur + (e.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length);
    } else if (searching && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const next = moveHighlight(hi, e.key, searchList.length);
      setHi(next);
      if (next >= 0) listRef.current?.reveal(next);
    } else if (suggestOpen && (e.key === 'Enter' || e.key === 'Tab')) {
      e.preventDefault();
      accept(suggestions[cur]);
    } else if (e.key === 'Escape' && suggestOpen) {
      e.preventDefault();
      setDismissed(true);
    } else if (e.key === 'Escape' && input !== '') {
      // Esc clears the search first: it must not also deselect and reset the view (App.tsx), the next Esc does
      e.preventDefault();
      e.stopPropagation();
      endSearch();
    } else if (e.key === 'Enter' && searching) {
      // select the highlighted result, else the first. The text is looked up now (not after the typing pause) so the ranking is
      // for what is typed; a server-ranked catalogue (store.ts askServer) answers a moment later, so a very quick Enter there
      // still sees the previous ranking
      e.preventDefault();
      setSearchText(typed);
      const s = useStore.getState();
      const fresh = searchRows(ordered, s.searchHits, typed, listedBy(s.entities, pendingQuery(s.query, input), s.searchIds));
      const id = pickedResult(sorters.item ? [...fresh].sort(sorters.item) : fresh, hi);
      if (id) pickResult(id);
    } else if (e.key === 'Backspace' && backspaceRemovesChip(input, e.currentTarget.selectionStart, e.currentTarget.selectionEnd, chips.length)) {
      // nothing in front of the caret to delete: the chip before the field goes (the typed text stays)
      e.preventDefault();
      const last = chips[chips.length - 1];
      removeTerm(last.key, last.value, !!last.neg);
    }
  };
  /** CLEAR: the applied chips and text and the typed search; the hidden groups stay (SHOW ALL) */
  const clearAll = () => {
    endSearch();
    clearQuery();
  };

  const hasHidden = hasHide(query);
  const hidesTerm = (key: TagKey, value: string) => findTerm(query, key, value)?.effect === 'hide';

  // ---------------------------------------------------------------- rows

  const entityRow = (id: string, name: string, kind: string, depth: number, key: string, searchRow = false, highlighted = false) => {
    const rec = entities.get(id);
    const isFrame = frame === id && !isEarthCentre(id);
    const cls = `row${id === selectedId ? ' sel' : ''}${highlighted ? ' hi' : ''}`;
    return (
      <button
        key={key} className={cls} style={{ height: ROW_H, paddingLeft: searchRow ? undefined : 10 + depth * INDENT_PX }}
        onClick={() => (searchRow ? pickResult(id) : pick(id))}>
        <i className="swatch" style={{ background: `var(--c-${rec ? colorKeyOf(rec) : 'satellites'}, var(--c-satellites))` }} />
        <span className="row-name">{name}</span>
        {isFrame && <span className="row-frame" title="The frame of reference is centred on this object">Frame</span>}
        <span className="row-kind">{kindLabel(kind)}</span>
      </button>
    );
  };

  const eyeButton = (token: [TagKey, string], label: string) => {
    const off = hidesTerm(token[0], token[1]);
    return (
      <button
        className={off ? 'eye off' : 'eye'} aria-pressed={off} aria-label={`${off ? 'Show' : 'Hide'} ${label}`}
        title={off ? `Show ${label} again` : `Hide ${label} (not drawn, not listed)`}
        onClick={() => toggleTerm(token[0], token[1], 'hide')}>
        <Eye off={off} />
      </button>
    );
  };

  const renderTree = (i: number) => {
    const r = treeRows[i];
    const pad = 6 + r.depth * INDENT_PX;
    if (r.type === 'entity') {
      const rec = entities.get(r.id);
      return entityRow(r.id, rec?.name ?? r.id, rec ? typeOf(rec) : '', r.depth, r.key);
    }
    if (r.type === 'group') {
      return (
        <div key={r.key} className="row tree-group" style={{ height: ROW_H, paddingLeft: pad }}>
          <button className="tree-group-name" aria-expanded={r.open} onClick={() => setOpen(r.key, !r.open)}>
            <span className="tree-chev" aria-hidden="true">{r.open ? '▾' : '▸'}</span>
            <span className="row-name">{r.label ?? kindLabel(r.kind)}</span>
          </button>
          <span className="tree-count mono">{r.count.toLocaleString('en-US')}</span>
          {!r.label && !BODY_CATEGORY_KINDS.has(r.kind) && eyeButton(['type', r.kind.toLowerCase()], `every ${kindLabel(r.kind)}`)}
        </div>
      );
    }
    const active = !!r.entityId && (r.entityId === frame || r.entityId === selectedId);
    const bodyOff = hidesTerm('body', r.bodyId.toLowerCase());
    return (
      <div key={r.key} className={`row tree-body${active ? ' sel' : ''}${bodyOff ? ' is-hidden' : ''}`} style={{ height: ROW_H, paddingLeft: pad }}>
        <button className="tree-chev" aria-expanded={r.open} aria-label={`${r.open ? 'Collapse' : 'Expand'} ${r.name}`} onClick={() => setOpen(r.key, !r.open)}>
          {r.open ? '▾' : '▸'}
        </button>
        <button
          className="tree-body-name" onClick={() => chooseBody(r.key, r.entityId)}
          title={`Select the ${r.name} (it becomes the frame of reference unless the frame is locked) and fly there`}>
          {r.name}
        </button>
        <span className="tree-count mono">{r.count.toLocaleString('en-US')}</span>
        {eyeButton(['body', r.bodyId.toLowerCase()], `everything under the ${r.name} (its moons too)`)}
      </div>
    );
  };

  /** a term as a chip: the word, an eye (an only term hides instead and back) and an x */
  const chipView = (t: Term) => {
    const w = termWord(t);
    const hide = t.effect === 'hide';
    const text = t.key === 'text';
    const cls = `tagchip${t.neg ? ' neg' : ''}${hide ? ' hide' : ''}`;
    return (
      <span key={w} className={cls} title={text ? `Only names matching "${w}"` : hide ? `Hidden: ${w} is not drawn nor listed` : t.neg ? `Leaves out ${w.slice(1)}` : `Only ${w}`}>
        <span className="tagchip-text">{text ? `"${w}"` : w}</span>
        {!t.neg && !text && (
          <button
            className="tagchip-btn" aria-pressed={hide} aria-label={`${hide ? 'Show only' : 'Hide'} ${w}`}
            title={hide ? 'Show only these objects instead' : 'Hide these objects (not drawn, not listed) instead of showing only them'}
            onClick={() => setTermEffect(t.key, t.value, hide ? 'only' : 'hide')}>
            <Eye off={hide} />
          </button>
        )}
        <button className="tagchip-btn" aria-label={`Remove ${w}`} title={text ? 'Remove this text filter' : 'Remove this tag'} onClick={() => removeTerm(t.key, t.value, !!t.neg)}>×</button>
      </span>
    );
  };

  return (
    <aside className="panel left" ref={panelRef}>
      <div className="panel-head">
        <span>Objects</span>
        <select
          className="sort-select" value={sort} aria-label="Sort the list within each group" title="Sort the list within each group"
          onChange={(e) => setSort(parseSortMode(e.target.value))}>
          {SORT_MODES.map((m) => <option key={m.id} value={m.id} title={m.hint}>{m.id === 'default' ? 'Sort' : m.label}</option>)}
        </select>
        <span className="mono dim">{(searching ? searchResults : rows).length.toLocaleString('en-US')}{query.terms.length || searching ? '' : ` / ${entities.size.toLocaleString('en-US')}`}</span>
      </div>
      <div className="search">
        <div className="search-box" onClick={() => inputRef.current?.focus()}>
          {chips.map(chipView)}
          <input
            ref={inputRef} type="text" role="combobox" aria-expanded={suggestOpen} aria-controls="tag-suggest" aria-autocomplete="list"
            aria-activedescendant={suggestOpen ? `tag-opt-${cur}` : undefined}
            placeholder={chips.length ? '' : 'Search by name or #tag, e.g. type:probe'}
            value={input} onChange={(e) => onInput(e.target.value)} onKeyDown={onKeyDown}
            onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
            spellCheck={false} autoComplete="off" aria-label="Search entities by name or tag"
          />
          <button
            className={help ? 'search-help on' : 'search-help'} aria-pressed={help} aria-label="Tag help" title="How to search with tags"
            onMouseDown={(e) => e.preventDefault()} onClick={() => setHelp((h) => !h)}>
            ?
          </button>
          <button
            className="search-filter" disabled={!searching} onMouseDown={(e) => e.preventDefault()} onClick={applyFilter}
            title="Apply what is typed as a filter: the tree and the scene show only the matches">
            Filter
          </button>
        </div>
        {suggestOpen && (
          <ul id="tag-suggest" className="tag-suggest" role="listbox" aria-label="Tag suggestions">
            {suggestions.map((s, i) => (
              <li
                key={s.value} id={`tag-opt-${i}`} role="option" aria-selected={i === cur} className={i === cur ? 'cur' : undefined}
                onMouseDown={(e) => { e.preventDefault(); accept(s); }} onMouseEnter={() => setSel(i)}>
                <span className="tag-suggest-v">{s.value}</span>
                {s.label && s.label.toLowerCase() !== s.value && <span className="tag-suggest-l">{s.label}</span>}
                <small className="mono dim">{s.count.toLocaleString('en-US')}</small>
              </li>
            ))}
          </ul>
        )}
        {help && (
          <div className="search-helptext">
            <div>Type words to search by name, or tags to pick a group: the matches are listed and nothing else changes. Click a result, or press Up/Down and Enter, to select it; Enter alone takes the first. Filter (or a category chip) applies the search as a filter: the tree and the scene show only the matches, as chips you can remove. Esc clears the search. Different keys combine; the same key twice means either.</div>
            <dl>
              {HELP_TAGS.map(([t, d]) => (
                <div key={t}><dt className="mono">{t}</dt><dd>{d}</dd></div>
              ))}
            </dl>
            <div>Type <span className="mono">group:</span>, <span className="mono">#</span> or <span className="mono">launch:</span> to list the groups or launches. The eye on a category, a tag chip or a tree header hides it: not drawn, not listed. A filter also thins the scene; highlight dims instead.</div>
          </div>
        )}
      </div>
      <div className="facets">
        <div className="chips" role="group" aria-label="Categories">
          {categories.map(([id, n]) => {
            const term = findTerm(query, 'type', id);
            const on = term?.effect === 'only';
            const off = term?.effect === 'hide';
            const cat = CATEGORIES.find((c) => c.id === id);
            return (
              <span key={id} className={`chip-pair${off ? ' off' : ''}`}>
                <button
                  className={on ? 'chip on' : 'chip'} aria-pressed={on} title={`${cat?.hint ?? id} (tag type:${id})`}
                  onClick={() => toggleTerm('type', id, 'only')}>
                  <i className="swatch" style={{ background: `var(--c-${id})` }} />
                  {categoryLabel(id)} <small>{n.toLocaleString('en-US')}</small>
                </button>
                {id !== 'bodies' && (
                  <button
                    className={off ? 'eye off' : 'eye'} aria-pressed={off} aria-label={`${off ? 'Show' : 'Hide'} ${categoryLabel(id)}`}
                    title={off ? `Show ${categoryLabel(id)} again` : `Hide ${categoryLabel(id)} (not drawn, not listed)`}
                    onClick={() => toggleTerm('type', id, 'hide')}>
                    <Eye off={off} />
                  </button>
                )}
              </span>
            );
          })}
          {hasHidden && <button className="chip more" onClick={showAll} title="Show every hidden group again">Show all</button>}
          {(filtering || input !== '') && <button className="chip clear" onClick={clearAll} title="Clear the search: the chips and the typed text (hidden groups stay)">Clear</button>}
        </div>
      </div>
      {searching ? (
        searchList.length === 0 ? (
          <div className="empty">No matches.</div>
        ) : (
          <VirtualList
            key="search" ref={listRef} count={searchList.length} rowHeight={ROW_H}
            render={(i) => {
              const r = searchList[i];
              return entityRow(r.id, r.name, r.kind, 0, r.id, true, i === hi);
            }}
          />
        )
      ) : rows.length === 0 ? (
        <div className="empty">No matching entities.</div>
      ) : (
        <VirtualList key="tree" ref={listRef} count={treeRows.length} rowHeight={ROW_H} render={renderTree} sticky={stickyOf} />
      )}
    </aside>
  );
}
