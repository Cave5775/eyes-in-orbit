import { defaultBodies } from '@eio/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { buildTreeRows, type TreeBody } from '../lib/entity-tree';
import { colorKeyOf, kindLabel } from '../lib/entity';
import { browseOrder, buildLaunchGroups, facetCounts, filtersActive, matchesFilters, rankEntities, type SearchHit } from '../lib/filters';
import { bodyCentre, isOrbitableBody, sameCentre } from '../lib/frame';
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
    return buildTreeRows(rows, {
      bodies: TREE_BODIES, frame, frameBodyId: frame.kind === 'entity' ? entities.get(frame.id)?.bodyId : undefined,
      openAll: filtering, overrides, kindName: kindLabel, bodyOf: (r) => entities.get(r.id)?.bodyId,
    });
  }, [mode, rows, entities, frame, filtering, overrides]);

  const chooseBody = (bodyId: string, key: string, open: boolean) => {
    if (isOrbitableBody(bodyId)) {
      setOpen(key, true);
      setFrame(bodyCentre(bodyId), { fly: true });
    } else setOpen(key, !open); // no display for it (Mars): just fold
  };

  const entityRow = (id: string, name: string, kind: string, depth: number, key: string) => {
    const rec = entities.get(id);
    const isFrame = frame.kind === 'entity' && frame.id === id;
    return (
      <button
        key={key} className={id === selectedId ? 'row sel' : 'row'} style={{ height: ROW_H, paddingLeft: mode === 'tree' ? 10 + depth * INDENT_PX : undefined }}
        onClick={() => select(id)}>
        <i className="swatch" style={{ background: `var(--c-${rec ? colorKeyOf(rec) : 'satellite'})` }} />
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
    const orbitable = isOrbitableBody(r.bodyId);
    const active = sameCentre(frame, bodyCentre(r.bodyId));
    return (
      <div key={r.key} className={active ? 'row tree-body sel' : 'row tree-body'} style={{ height: ROW_H, paddingLeft: pad }}>
        <button className="tree-chev" aria-expanded={r.open} aria-label={`${r.open ? 'Collapse' : 'Expand'} ${r.name}`} onClick={() => setOpen(r.key, !r.open)}>
          {r.open ? '▾' : '▸'}
        </button>
        <button
          className="tree-body-name" onClick={() => chooseBody(r.bodyId, r.key, r.open)}
          title={orbitable ? `Set the frame of reference to the ${r.name} and fly there` : `${r.name} has no display yet: it cannot be the frame of reference`}>
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
        <div className="chips">
          {facets.kinds.slice(0, 10).map(([k, n]) => (
            <button key={k} className={filters.kinds.has(k) ? 'chip on' : 'chip'} onClick={() => toggleKind(k)}>
              {kindLabel(k)} <small>{n.toLocaleString('en-US')}</small>
            </button>
          ))}
        </div>
        <div className="chips">
          {facets.groups.slice(0, 8).map(([g, n]) => (
            <button key={g} className={filters.groups.has(g) ? 'chip on alt' : 'chip alt'} onClick={() => toggleGroup(g)}>
              {g} <small>{n.toLocaleString('en-US')}</small>
            </button>
          ))}
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
