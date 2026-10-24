import { bodyEntityId, defaultBodies } from '@eio/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { BODY_KINDS, GROUP_CHIP_CAP, KIND_CHIP_CAP, capChips } from '../lib/browser-ui';
import { buildTreeRows, type TreeBody } from '../lib/entity-tree';
import { colorKeyOf, kindLabel } from '../lib/entity';
import { browseOrder, buildLaunchGroups, facetCounts, filtersActive, matchesFilters, rankEntities, type SearchHit } from '../lib/filters';
import { bodyCentre, sameCentre } from '../lib/frame';
import { useStore } from '../state/store';
import { LaunchFilter } from './LaunchFilter';
import { VirtualList } from './VirtualList';

const ROW_H = 28;
const SEARCH_LIMIT = 60;
const DEBOUNCE_MS = 250;
const INDENT_PX = 12;
const MODE_KEY = 'eio.browser';

type Mode = 'tree' | 'list';

/** The body tree the entity tree nests under (SUN > EARTH > MOON, SUN > MARS). */
const TREE_BODIES: TreeBody[] = defaultBodies.all().map((b) => ({ id: b.id, name: b.name, parentId: b.parentId }));

function loadMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === 'list' ? 'list' : 'tree';
  } catch {
    return 'tree';
  }
}

export function EntityBrowser() {
  const entities = useStore((s) => s.entities);
  const filters = useStore((s) => s.filters);
  const query = useStore((s) => s.query);
  const results = useStore((s) => s.searchResults);
  const selectedId = useStore((s) => s.selectedId);
  const frame = useStore((s) => s.frame);
  const { setQuery, setSearchResults, select, toggleKind, toggleGroup, clearFilters, setFrame } = useStore.getState();
  const [input, setInput] = useState(query);
  const [mode, setModeState] = useState<Mode>(loadMode);
  /** explicit open / closed choices of tree nodes by row key; they win over the defaults (see buildTreeRows) */
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const setMode = (m: Mode) => {
    setModeState(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch { /* private window: the choice just is not remembered */ }
  };
  const setOpen = useCallback((key: string, open: boolean) => setOverrides((o) => new Map(o).set(key, open)), []);
  // a new query or filter starts from the defaults again (everything with a hit open)
  useEffect(() => setOverrides((o) => (o.size ? new Map() : o)), [query, filters]);

  useEffect(() => {
    const h = setTimeout(() => setQuery(input.trim()), DEBOUNCE_MS);
    return () => clearTimeout(h);
  }, [input, setQuery]);

  // server-ranked search; falls back to local ranking when the request fails
  useEffect(() => {
    if (!query) {
      setSearchResults(null);
      return;
    }
    let stale = false;
    api.search(query, SEARCH_LIMIT)
      .catch(() => rankEntities(useStore.getState().entities.values(), query, SEARCH_LIMIT))
      .then((r) => !stale && setSearchResults(r));
    return () => { stale = true; };
  }, [query, setSearchResults]);

  const facets = useMemo(() => facetCounts(entities.values()), [entities]);
  // the chip strips show the most common kinds and groups; the body kinds stay visible, switched-on chips too, and "more"
  // opens every one of them in a scrollable strip
  const [moreChips, setMoreChips] = useState(false);
  const kindChips = useMemo(
    () => capChips(facets.kinds, KIND_CHIP_CAP, { expanded: moreChips, pinned: BODY_KINDS, active: filters.kinds }),
    [facets, moreChips, filters.kinds]);
  const groupChips = useMemo(
    () => capChips(facets.groups, GROUP_CHIP_CAP, { expanded: moreChips, active: filters.groups }),
    [facets, moreChips, filters.groups]);
  const launchGroups = useMemo(() => buildLaunchGroups(entities.values()), [entities]);

  const rows: SearchHit[] = useMemo(() => {
    if (query) return (results ?? []).filter((r) => matchesFilters(r, filters));
    const out: SearchHit[] = [];
    for (const e of entities.values()) if (matchesFilters(e, filters)) out.push(e);
    return out.sort(browseOrder);
  }, [entities, filters, query, results]);

  // the tree: the same filtered, ordered rows, nested under their primary body and flattened to the rows that are open
  const filtering = !!query || filtersActive(filters);
  const treeRows = useMemo(() => {
    if (mode !== 'tree') return [];
    // a body that has an entity in the catalog carries it, so the node can select it even when a filter hides its row
    const bodies = TREE_BODIES.map((b) => {
      const entityId = bodyEntityId(b.id);
      return entities.has(entityId) ? { ...b, entityId } : b;
    });
    const recOf = (r: { id: string }) => entities.get(r.id);
    return buildTreeRows(rows, {
      bodies, frame, frameBodyId: frame.kind === 'entity' ? entities.get(frame.id)?.bodyId : undefined,
      openAll: filtering, overrides, kindName: kindLabel, bodyOf: (r) => recOf(r)?.bodyId,
      standsForBody: (r) => { const p = recOf(r)?.provider; return p?.type === 'body' ? p.bodyId : undefined; },
    });
  }, [mode, rows, entities, frame, filtering, overrides]);

  // a body node: the camera flies to the body and the frame becomes it (as the old node click did); its entity is selected
  // too, so the detail panel shows the body. The frame is set first because a body fly clears the selection.
  const chooseBody = (bodyId: string, key: string, entityId?: string) => {
    setOpen(key, true);
    setFrame(bodyCentre(bodyId), { fly: true });
    if (entityId && useStore.getState().entities.has(entityId)) select(entityId);
  };

  const entityRow = (id: string, name: string, kind: string, depth: number, key: string) => {
    const rec = entities.get(id);
    const isFrame = frame.kind === 'entity' && frame.id === id;
    return (
      <button
        key={key} className={id === selectedId ? 'row sel' : 'row'} style={{ height: ROW_H, paddingLeft: mode === 'tree' ? 10 + depth * INDENT_PX : undefined }}
        onClick={() => select(id)}>
        <i className="swatch" style={{ background: `var(--c-${rec ? colorKeyOf(rec) : 'satellite'}, var(--c-satellite))` }} />
        <span className="row-name">{name}</span>
        {isFrame && <span className="row-frame" title="The frame of reference is centred on this object">FRAME</span>}
        <span className="row-kind">{kindLabel(kind)}</span>
      </button>
    );
  };

  const renderTree = (i: number) => {
    const r = treeRows[i];
    const pad = 6 + r.depth * INDENT_PX;
    if (r.type === 'entity') {
      const rec = entities.get(r.id);
      return entityRow(r.id, rec?.name ?? r.id, rec?.kind ?? '', r.depth, r.key);
    }
    if (r.type === 'group') {
      return (
        <button key={r.key} className="row tree-group" style={{ height: ROW_H, paddingLeft: pad }} aria-expanded={r.open} onClick={() => setOpen(r.key, !r.open)}>
          <span className="tree-chev" aria-hidden="true">{r.open ? '▾' : '▸'}</span>
          <span className="row-name">{kindLabel(r.kind)}</span>
          <span className="tree-count mono">{r.count.toLocaleString('en-US')}</span>
        </button>
      );
    }
    const active = sameCentre(frame, bodyCentre(r.bodyId)) || (!!r.entityId && r.entityId === selectedId);
    return (
      <div key={r.key} className={active ? 'row tree-body sel' : 'row tree-body'} style={{ height: ROW_H, paddingLeft: pad }}>
        <button className="tree-chev" aria-expanded={r.open} aria-label={`${r.open ? 'Collapse' : 'Expand'} ${r.name}`} onClick={() => setOpen(r.key, !r.open)}>
          {r.open ? '▾' : '▸'}
        </button>
        <button
          className="tree-body-name" onClick={() => chooseBody(r.bodyId, r.key, r.entityId)}
          title={`Select the ${r.name}, make it the frame of reference and fly there`}>
          {r.name.toUpperCase()}
        </button>
        <span className="tree-count mono">{r.count.toLocaleString('en-US')}</span>
      </div>
    );
  };

  return (
    <aside className="panel left">
      <div className="panel-head">
        <span>ENTITIES</span>
        <span className="seg" role="group" aria-label="Entity view">
          <button className={mode === 'tree' ? 'seg-btn on' : 'seg-btn'} aria-pressed={mode === 'tree'} onClick={() => setMode('tree')} title="Group objects under the body they orbit (Sun, Earth, Moon, Mars)">TREE</button>
          <button className={mode === 'list' ? 'seg-btn on' : 'seg-btn'} aria-pressed={mode === 'list'} onClick={() => setMode('list')} title="One flat list">LIST</button>
        </span>
        <span className="mono dim">{rows.length.toLocaleString('en-US')}{filtering ? '' : ` / ${entities.size.toLocaleString('en-US')}`}</span>
      </div>
      <div className="search">
        <input
          type="search" placeholder="Search name, NORAD, COSPAR..." value={input}
          onChange={(e) => setInput(e.target.value)} spellCheck={false} aria-label="Search entities"
        />
      </div>
      <div className="facets">
        <div className={moreChips ? 'chips chips-scroll' : 'chips'}>
          {kindChips.shown.map(([k, n]) => (
            <button key={k} className={filters.kinds.has(k) ? 'chip on' : 'chip'} onClick={() => toggleKind(k)}>
              {kindLabel(k)} <small>{n.toLocaleString('en-US')}</small>
            </button>
          ))}
        </div>
        <div className={moreChips ? 'chips chips-scroll' : 'chips'}>
          {moreChips && <button className="chip more" onClick={() => setMoreChips(false)} title="Show the most common kinds and groups only">fewer</button>}
          {groupChips.shown.map(([g, n]) => (
            <button key={g} className={filters.groups.has(g) ? 'chip on alt' : 'chip alt'} onClick={() => toggleGroup(g)}>
              {g} <small>{n.toLocaleString('en-US')}</small>
            </button>
          ))}
          {(groupChips.hidden > 0 || kindChips.hidden > 0) && (
            <button className="chip more" onClick={() => setMoreChips(true)} title="Show every kind and group">
              +{groupChips.hidden + kindChips.hidden} more
            </button>
          )}
          {filtersActive(filters) && <button className="chip clear" onClick={clearFilters}>CLEAR</button>}
        </div>
        <LaunchFilter groups={launchGroups} />
      </div>
      {rows.length === 0 ? (
        <div className="empty">{query && results === null ? 'Searching...' : 'No matching entities.'}</div>
      ) : (
        mode === 'tree' ? (
          <VirtualList key="tree" count={treeRows.length} rowHeight={ROW_H} render={renderTree} />
        ) : (
          <VirtualList
            key="list"
            count={rows.length}
            rowHeight={ROW_H}
            render={(i) => {
              const r = rows[i];
              return entityRow(r.id, r.name, r.kind, 0, r.id);
            }}
          />
        )
      )}
    </aside>
  );
}
