import { bodyEntityId, defaultBodies } from '@eio/core';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { api } from '../api/client';
import { BODY_CATEGORY_KINDS, CATEGORIES, categoryCounts, categoryLabel } from '../lib/browser-ui';
import { buildTreeRows, revealKeys, revealRowIndex, type TreeBody } from '../lib/entity-tree';
import { colorKeyOf, kindLabel } from '../lib/entity';
import {
  browseOrder, buildLaunchGroups, facetCounts, filtersActive, isHiddenRec, matchesFilters, rankEntities, type SearchHit,
} from '../lib/filters';
import { bodyCentre, sameCentre } from '../lib/frame';
import {
  acceptTag, activeTag, hiddenCount, hiddenTokens, isTagHidden, parseQuery, parseToken, splitCommitted, suggestTags, tagsActive,
  type TagKey, type TagSuggestion,
} from '../lib/search-tags';
import { useStore } from '../state/store';
import { LaunchFilter } from './LaunchFilter';
import { VirtualList, type VirtualListHandle } from './VirtualList';

const ROW_H = 28;
const SEARCH_LIMIT = 60;
/** a search with tags ranks the entities that pass them locally (the server does not know the tags), so it can list more */
const TAG_SEARCH_LIMIT = 500;
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
  ['kind:probe', 'an object type (launch_vehicle, ground_station...)'],
  ['launch:2024-123', 'one launch (launch:1993 is a year)'],
  ['cat:navigation', 'a category (the chips above)'],
  ['id:25544', 'a NORAD, COSPAR or entity id'],
  ['body:moon', 'what orbits that body'],
  ['-kind:debris', 'a leading - leaves those out'],
];

export function EntityBrowser() {
  const entities = useStore((s) => s.entities);
  const filters = useStore((s) => s.filters);
  const query = useStore((s) => s.query);
  const results = useStore((s) => s.searchResults);
  const selectedId = useStore((s) => s.selectedId);
  const frame = useStore((s) => s.frame);
  const { setQuery, setSearchResults, setTags, select, clearFilters, setFrame, toggleHidden, showAll } = useStore.getState();
  /** the free text and the tag word being typed */
  const [input, setInput] = useState(query);
  /** finished tag words (`group:starlink`, `-kind:debris`), shown as chips in the field */
  const [chips, setChips] = useState<string[]>([]);
  const [mode, setModeState] = useState<Mode>(loadMode);
  const [help, setHelp] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  /** explicit open / closed choices of tree nodes by row key; they win over the defaults (see buildTreeRows) */
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const setMode = (m: Mode) => {
    setModeState(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch { /* private window: the choice just is not remembered */ }
  };
  const setOpen = useCallback((key: string, open: boolean) => setOverrides((o) => new Map(o).set(key, open)), []);
  // a new query or filter starts from the defaults again (everything with a hit open); hiding a group is no filter
  useEffect(() => setOverrides((o) => (o.size ? new Map() : o)), [query, filters.kinds, filters.groups, filters.launch, filters.tags]);
  // reveal: a selection that did not come from a click in this browser opens the path to its row and scrolls to it
  const listRef = useRef<VirtualListHandle>(null);
  /** the id a row click here just selected: the effect below skips it, so the list never moves under the cursor */
  const ownSelect = useRef<string | null>(null);
  /** the entity whose row is still to be scrolled to once the expansion has reached the list */
  const [revealId, setRevealId] = useState<string | null>(null);

  // the field = tag chips + free text; both go to the store (text for the search, tags for the list and the scene). Typing is
  // debounced, a chip change applies at once.
  const lastInput = useRef(input);
  useEffect(() => {
    const typed = lastInput.current !== input;
    lastInput.current = input;
    const apply = () => {
      const p = parseQuery([...chips, input].join(' '));
      setQuery(p.text);
      setTags(p.tags);
    };
    if (!typed) {
      apply();
      return;
    }
    const h = setTimeout(apply, DEBOUNCE_MS);
    return () => clearTimeout(h);
  }, [input, chips, setQuery, setTags]);

  const tagged = tagsActive(filters.tags);
  // server-ranked search; falls back to local ranking when the request fails. With tags the entities that pass them are
  // ranked locally instead (see `rows`).
  useEffect(() => {
    if (!query || tagged) {
      setSearchResults(null);
      return;
    }
    let stale = false;
    api.search(query, SEARCH_LIMIT)
      .catch(() => rankEntities(useStore.getState().entities.values(), query, SEARCH_LIMIT))
      .then((r) => !stale && setSearchResults(r));
    return () => { stale = true; };
  }, [query, tagged, setSearchResults]);

  const facets = useMemo(() => facetCounts(entities.values()), [entities]);
  const categories = useMemo(() => categoryCounts(entities.values()), [entities]);
  const launchGroups = useMemo(() => buildLaunchGroups(entities.values()), [entities]);

  // autocomplete for `group:` / `#`, `kind:`, `cat:`, `launch:`, `body:`
  const sources = useMemo((): Record<TagKey, TagSuggestion[]> => {
    const bodies = new Map<string, number>();
    for (const e of entities.values()) bodies.set(e.bodyId.toLowerCase(), (bodies.get(e.bodyId.toLowerCase()) ?? 0) + 1);
    return {
      group: facets.groups.map(([value, count]) => ({ value: value.toLowerCase(), count })),
      kind: facets.kinds.map(([value, count]) => ({ value: value.toLowerCase(), count })),
      cat: categories.map(([id, count]) => ({ value: id, label: categoryLabel(id), count })),
      launch: launchGroups.map((g) => ({ value: g.id, label: g.label, count: g.count })),
      body: [...bodies].map(([value, count]) => ({ value, count })),
      id: [],
    };
  }, [entities, facets, categories, launchGroups]);
  const active = useMemo(() => activeTag(input), [input]);
  const suggestions = useMemo(() => (active ? suggestTags(active, sources[active.key]) : []), [active, sources]);
  const suggestOpen = focused && !dismissed && suggestions.length > 0;
  const cur = Math.min(sel, Math.max(0, suggestions.length - 1));

  const rows: SearchHit[] = useMemo(() => {
    // a hit carries kind and group only; the tags also look at the body, the colour key and the ids, from the entity table
    const pass = (r: SearchHit) => matchesFilters(entities.get(r.id) ?? r, filters);
    if (query && tagged) return rankEntities([...entities.values()].filter(pass), query, TAG_SEARCH_LIMIT);
    if (query) return (results ?? []).filter(pass);
    const out: SearchHit[] = [];
    for (const e of entities.values()) if (matchesFilters(e, filters)) out.push(e);
    return out.sort(browseOrder);
  }, [entities, filters, query, results, tagged]);

  // the tree: the same filtered, ordered rows, nested under their primary body and flattened to the rows that are open
  const filtering = !!query || filtersActive(filters);
  const pick = (id: string) => {
    ownSelect.current = id;
    select(id);
  };

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
    if (entityId && useStore.getState().entities.has(entityId)) pick(entityId);
  };

  useEffect(() => {
    const own = ownSelect.current === selectedId;
    ownSelect.current = null;
    const rec = selectedId && !own ? entities.get(selectedId) : undefined;
    // a search or filter that hides the entity is never cleared: then there is nothing to reveal and the list stays as it is
    if (!rec || !rows.some((r) => r.id === rec.id)) {
      setRevealId(null);
      return;
    }
    if (mode === 'tree') {
      const keys = revealKeys(rec, { bodies: TREE_BODIES });
      setOverrides((o) => (keys.every((k) => o.get(k) === true) ? o : new Map([...o, ...keys.map((k): [string, boolean] => [k, true])])));
    }
    setRevealId(rec.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a change of the selection reveals
  }, [selectedId]);

  useEffect(() => {
    if (revealId === null) return;
    const i = mode === 'tree' ? revealRowIndex(treeRows, revealId) : rows.findIndex((r) => r.id === revealId);
    if (i < 0) return; // the expansion has not reached the list yet
    listRef.current?.reveal(i);
    setRevealId(null);
  }, [revealId, mode, treeRows, rows]);
  useEffect(() => setRevealId(null), [query, filters.kinds, filters.groups, filters.launch, filters.tags]);

  // ---------------------------------------------------------------- the search field: chips, tags, autocomplete

  const addChips = (add: string[]) => setChips((c) => {
    const next = [...c];
    for (const w of add) if (!next.includes(w)) next.push(w);
    return next.length === c.length ? c : next;
  });
  const removeChip = (w: string) => setChips((c) => c.filter((x) => x !== w));
  const onInput = (v: string) => {
    setDismissed(false);
    setSel(0);
    const done = splitCommitted(v);
    if (done.chips.length) {
      addChips(done.chips);
      setInput(done.rest);
    } else setInput(v);
  };
  const accept = (s: TagSuggestion) => {
    if (!active) return;
    const { chip, rest } = acceptTag(input, active, s.value);
    addChips([chip]);
    setInput(rest);
    setDismissed(false);
    setSel(0);
    inputRef.current?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (suggestOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setSel((cur + (e.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length);
    } else if (suggestOpen && (e.key === 'Enter' || e.key === 'Tab')) {
      e.preventDefault();
      accept(suggestions[cur]);
    } else if (e.key === 'Escape' && suggestOpen) {
      e.preventDefault();
      setDismissed(true);
    } else if (e.key === 'Enter') {
      // finish a complete tag word that has no space after it yet
      const done = splitCommitted(`${input} `);
      if (done.chips.length) {
        addChips(done.chips);
        setInput(done.rest.trim());
      }
    } else if (e.key === 'Backspace' && input === '' && chips.length) {
      setChips((c) => c.slice(0, -1));
    }
  };
  const toggleCategoryChip = (id: string) => {
    const w = `cat:${id}`;
    if (chips.includes(w)) removeChip(w);
    else addChips([w]);
  };
  /** hide the group a chip names: the chip leaves the search (it would show only what is hidden) and joins the hidden list */
  const hideChip = (w: string) => {
    const t = parseToken(w);
    if (!t || t.negated) return;
    toggleHidden(t.key, t.value, true);
    removeChip(w);
  };
  const toggleCategoryHidden = (id: string) => {
    if (!isTagHidden(filters.hidden, 'cat', id)) removeChip(`cat:${id}`);
    toggleHidden('cat', id);
  };
  const clearAll = () => {
    setChips([]);
    clearFilters();
  };

  const hidden = filters.hidden;
  const hiddenN = hiddenCount(hidden);
  const selRec = selectedId ? entities.get(selectedId) : undefined;
  const selHidden = !!selRec && isHiddenRec(selRec, filters);

  // ---------------------------------------------------------------- rows

  const entityRow = (id: string, name: string, kind: string, depth: number, key: string) => {
    const rec = entities.get(id);
    const isFrame = frame.kind === 'entity' && frame.id === id;
    const isHid = !!rec && isHiddenRec(rec, filters);
    const cls = `row${id === selectedId ? ' sel' : ''}${isHid ? ' is-hidden' : ''}`;
    return (
      <button
        key={key} className={cls} style={{ height: ROW_H, paddingLeft: mode === 'tree' ? 10 + depth * INDENT_PX : undefined }}
        onClick={() => pick(id)}>
        <i className="swatch" style={{ background: `var(--c-${rec ? colorKeyOf(rec) : 'satellite'}, var(--c-satellite))` }} />
        <span className="row-name">{name}</span>
        {isHid && (
          <span className="row-hidden" title={id === selectedId ? 'In a hidden group; shown in the scene while it is selected' : 'In a hidden group: not drawn in the scene'}>
            {id === selectedId ? 'HIDDEN, SHOWN' : 'HIDDEN'}
          </span>
        )}
        {isFrame && <span className="row-frame" title="The frame of reference is centred on this object">FRAME</span>}
        <span className="row-kind">{kindLabel(kind)}</span>
      </button>
    );
  };

  const eyeButton = (token: [TagKey, string], label: string) => {
    const off = isTagHidden(hidden, token[0], token[1]);
    return (
      <button
        className={off ? 'eye off' : 'eye'} aria-pressed={off} aria-label={`${off ? 'Show' : 'Hide'} ${label}`}
        title={off ? `Show ${label} in the scene again` : `Hide ${label} in the scene (they stay in this list)`}
        onClick={() => toggleHidden(token[0], token[1])}>
        <Eye off={off} />
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
      const off = isTagHidden(hidden, 'kind', r.kind);
      return (
        <div key={r.key} className={off ? 'row tree-group is-hidden' : 'row tree-group'} style={{ height: ROW_H, paddingLeft: pad }}>
          <button className="tree-group-name" aria-expanded={r.open} onClick={() => setOpen(r.key, !r.open)}>
            <span className="tree-chev" aria-hidden="true">{r.open ? '▾' : '▸'}</span>
            <span className="row-name">{kindLabel(r.kind)}</span>
          </button>
          <span className="tree-count mono">{r.count.toLocaleString('en-US')}</span>
          {!BODY_CATEGORY_KINDS.has(r.kind) && eyeButton(['kind', r.kind.toLowerCase()], `every ${kindLabel(r.kind)}`)}
        </div>
      );
    }
    const active = sameCentre(frame, bodyCentre(r.bodyId)) || (!!r.entityId && r.entityId === selectedId);
    const bodyOff = isTagHidden(hidden, 'body', r.bodyId.toLowerCase());
    return (
      <div key={r.key} className={`row tree-body${active ? ' sel' : ''}${bodyOff ? ' is-hidden' : ''}`} style={{ height: ROW_H, paddingLeft: pad }}>
        <button className="tree-chev" aria-expanded={r.open} aria-label={`${r.open ? 'Collapse' : 'Expand'} ${r.name}`} onClick={() => setOpen(r.key, !r.open)}>
          {r.open ? '▾' : '▸'}
        </button>
        <button
          className="tree-body-name" onClick={() => chooseBody(r.bodyId, r.key, r.entityId)}
          title={`Select the ${r.name}, make it the frame of reference and fly there`}>
          {r.name.toUpperCase()}
        </button>
        <span className="tree-count mono">{r.count.toLocaleString('en-US')}</span>
        {eyeButton(['body', r.bodyId.toLowerCase()], `everything under the ${r.name} (its moons too)`)}
      </div>
    );
  };

  const chipView = (w: string) => {
    const t = parseToken(w);
    const off = !!t && !t.negated && isTagHidden(hidden, t.key, t.value);
    return (
      <span key={w} className={t?.negated ? 'tagchip neg' : 'tagchip'} title={t?.negated ? `Leaves out ${w.slice(1)}` : `Only ${w}`}>
        <span className="tagchip-text">{w}</span>
        {t && !t.negated && !off && (
          <button className="tagchip-btn" aria-label={`Hide ${w} in the scene`} title="Hide these objects in the scene instead (moves the tag to the hidden list)" onClick={() => hideChip(w)}>
            <Eye off={false} />
          </button>
        )}
        <button className="tagchip-btn" aria-label={`Remove ${w}`} title="Remove this tag" onClick={() => removeChip(w)}>×</button>
      </span>
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
        <div className="search-box" onClick={() => inputRef.current?.focus()}>
          {chips.map(chipView)}
          <input
            ref={inputRef} type="text" role="combobox" aria-expanded={suggestOpen} aria-controls="tag-suggest" aria-autocomplete="list"
            aria-activedescendant={suggestOpen ? `tag-opt-${cur}` : undefined}
            placeholder={chips.length ? '' : 'Name or #tag, e.g. kind:probe'}
            value={input} onChange={(e) => onInput(e.target.value)} onKeyDown={onKeyDown}
            onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
            spellCheck={false} autoComplete="off" aria-label="Search entities by name or tag"
          />
          <button
            className={help ? 'search-help on' : 'search-help'} aria-pressed={help} aria-label="Tag help" title="How to search with tags"
            onMouseDown={(e) => e.preventDefault()} onClick={() => setHelp((h) => !h)}>
            ?
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
            <div>Type words to search by name, or tags to pick a group. A tag is kept as a chip once you press space, Enter or Tab. Different keys combine; the same key twice means either.</div>
            <dl>
              {HELP_TAGS.map(([t, d]) => (
                <div key={t}><dt className="mono">{t}</dt><dd>{d}</dd></div>
              ))}
            </dl>
            <div>Type <span className="mono">group:</span> or <span className="mono">#</span> to list the groups. The eye on a category, a tag chip or a tree header hides it in the scene.</div>
          </div>
        )}
      </div>
      <div className="facets">
        <div className="chips" role="group" aria-label="Categories">
          {categories.map(([id, n]) => {
            const on = chips.includes(`cat:${id}`);
            const off = isTagHidden(hidden, 'cat', id);
            const cat = CATEGORIES.find((c) => c.id === id);
            return (
              <span key={id} className={`chip-pair${off ? ' off' : ''}`}>
                <button
                  className={on ? 'chip on' : 'chip'} aria-pressed={on} title={`${cat?.hint ?? id} (tag cat:${id})`}
                  onClick={() => toggleCategoryChip(id)}>
                  {categoryLabel(id)} <small>{n.toLocaleString('en-US')}</small>
                </button>
                {id !== 'bodies' && (
                  <button
                    className={off ? 'eye off' : 'eye'} aria-pressed={off} aria-label={`${off ? 'Show' : 'Hide'} ${categoryLabel(id)}`}
                    title={off ? `Show ${categoryLabel(id)} in the scene again` : `Hide ${categoryLabel(id)} in the scene (they stay in this list)`}
                    onClick={() => toggleCategoryHidden(id)}>
                    <Eye off={off} />
                  </button>
                )}
              </span>
            );
          })}
          {(filtersActive(filters) || chips.length > 0) && <button className="chip clear" onClick={clearAll}>CLEAR</button>}
        </div>
        {hiddenN > 0 && (
          <div className="hidden-strip" role="group" aria-label="Hidden groups">
            <span className="hidden-label" title="Not drawn in the scene; still listed here">HIDDEN</span>
            {hiddenTokens(hidden).map((w) => {
              const t = parseToken(w)!;
              return (
                <button key={w} className="chip hid" title={`Show ${w} again`} aria-label={`Show ${w} again`} onClick={() => toggleHidden(t.key, t.value, false)}>
                  <Eye off />
                  {t.key === 'cat' ? categoryLabel(t.value) : w}
                </button>
              );
            })}
            <button className="chip more" onClick={showAll} title="Show every hidden group again">SHOW ALL</button>
            {selHidden && <span className="hidden-note">The selected object stays visible.</span>}
          </div>
        )}
        <LaunchFilter groups={launchGroups} />
      </div>
      {rows.length === 0 ? (
        <div className="empty">{query && results === null && !tagged ? 'Searching...' : 'No matching entities.'}</div>
      ) : (
        mode === 'tree' ? (
          <VirtualList key="tree" ref={listRef} count={treeRows.length} rowHeight={ROW_H} render={renderTree} />
        ) : (
          <VirtualList
            key="list"
            ref={listRef}
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
