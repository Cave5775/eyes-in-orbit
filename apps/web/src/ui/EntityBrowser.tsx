import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { colorKeyOf, kindLabel } from '../lib/entity';
import { browseOrder, facetCounts, filtersActive, matchesFilters, rankEntities, type SearchHit } from '../lib/filters';
import { useStore } from '../state/store';
import { VirtualList } from './VirtualList';

const ROW_H = 28;
const SEARCH_LIMIT = 60;
const DEBOUNCE_MS = 250;

export function EntityBrowser() {
  const entities = useStore((s) => s.entities);
  const filters = useStore((s) => s.filters);
  const query = useStore((s) => s.query);
  const results = useStore((s) => s.searchResults);
  const selectedId = useStore((s) => s.selectedId);
  const { setQuery, setSearchResults, select, toggleKind, toggleGroup, clearFilters } = useStore.getState();
  const [input, setInput] = useState(query);

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

  const rows: SearchHit[] = useMemo(() => {
    if (query) return (results ?? []).filter((r) => matchesFilters(r, filters));
    const out: SearchHit[] = [];
    for (const e of entities.values()) if (matchesFilters(e, filters)) out.push(e);
    return out.sort(browseOrder);
  }, [entities, filters, query, results]);

  return (
    <aside className="panel left">
      <div className="panel-head">
        <span>ENTITIES</span>
        <span className="mono dim">{rows.length.toLocaleString('en-US')}{query || filtersActive(filters) ? '' : ` / ${entities.size.toLocaleString('en-US')}`}</span>
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
      </div>
      {rows.length === 0 ? (
        <div className="empty">{query && results === null ? 'Searching...' : 'No matching entities.'}</div>
      ) : (
        <VirtualList
          count={rows.length}
          rowHeight={ROW_H}
          render={(i) => {
            const r = rows[i];
            const rec = entities.get(r.id);
            return (
              <button key={r.id} className={r.id === selectedId ? 'row sel' : 'row'} style={{ height: ROW_H }} onClick={() => select(r.id)}>
                <i className="swatch" style={{ background: `var(--c-${rec ? colorKeyOf(rec) : 'satellite'})` }} />
                <span className="row-name">{r.name}</span>
                <span className="row-kind">{kindLabel(r.kind)}</span>
              </button>
            );
          }}
        />
      )}
    </aside>
  );
}
