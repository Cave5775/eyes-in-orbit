import { bodyEntityId, bodyOf, defaultBodies } from '@eio/core';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { BODY_CATEGORY_KINDS, CATEGORIES, categoryCounts, categoryLabel } from '../lib/browser-ui';
import { buildTreeRows, revealKeys, revealRowIndex, stickyAncestors, type TreeBody } from '../lib/entity-tree';
import { colorKeyOf, kindLabel } from '../lib/entity';
import { browseOrder, facetCounts, type SearchHit } from '../lib/filters';
import { isEarthCentre } from '../lib/frame';
import { buildLaunchGroups, launchMembers } from '../lib/launch-group';
import {
  NO_FOCUS, findTerm, hasHide, isDrawn, classify, queryActive, tagTerms, termFromWord, termWord, textOf, type Ctx, type Term,
} from '../lib/query';
import {
  acceptTag, activeTag, backspaceRemovesChip, parseQuery, splitCommitted, suggestTags, type TagKey, type TagSuggestion,
} from '../lib/search-tags';
import { runtime } from '../state/runtime';
import { useStore } from '../state/store';
import { VirtualList, type VirtualListHandle } from './VirtualList';

const ROW_H = 28;
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
  ['type:probe', 'what it is: a category (the chips above) or a kind (satellite, launch_vehicle, ground_station, moon...)'],
  ['launch:2024-123', 'one launch (launch:1993 is a year)'],
  ['type:navigation', 'a whole category (probes also holds rovers and landers)'],
  ['id:25544', 'a NORAD, COSPAR or entity id'],
  ['body:moon', 'what orbits that body'],
  ['-type:debris', 'a leading - leaves those out'],
];

export function EntityBrowser() {
  const entities = useStore((s) => s.entities);
  const query = useStore((s) => s.query);
  const textHits = useStore((s) => s.textHits);
  const textIds = useStore((s) => s.textIds);
  const selectedId = useStore((s) => s.selectedId);
  const frame = useStore((s) => s.frame);
  const { setText, addTerms, removeTerm, toggleTerm, setTermEffect, clearQuery, showAll, selectObject } = useStore.getState();
  /** the free text and the tag word being typed; the finished tag words are terms of the query (the chips) */
  const [input, setInput] = useState(() => textOf(query));
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

  // the typed text is the text term of the query. Typing is debounced; the chips (terms) apply at once.
  const lastInput = useRef(input);
  useEffect(() => {
    if (lastInput.current === input) return;
    lastInput.current = input;
    const h = setTimeout(() => setText(parseQuery(input).text), DEBOUNCE_MS);
    return () => clearTimeout(h);
  }, [input, setText]);

  const facets = useMemo(() => facetCounts(entities.values()), [entities]);
  const categories = useMemo(() => categoryCounts(entities.values()), [entities]);
  const launchGroups = useMemo(() => buildLaunchGroups(entities.values()), [entities]);

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
  }, [entities, facets, categories, launchGroups]);
  const active = useMemo(() => activeTag(input), [input]);
  const suggestions = useMemo(() => (active ? suggestTags(active, sources[active.key]) : []), [active, sources]);
  const suggestOpen = focused && !dismissed && suggestions.length > 0;
  const cur = Math.min(sel, Math.max(0, suggestions.length - 1));

  // the rows: what the query lets through (the same predicate the scene draws by, so the counts match what is drawn). Hidden
  // groups are not listed. The text ranks them; without text the notable kinds come first.
  const ordered = useMemo(() => [...entities.values()].sort(browseOrder), [entities]);
  const rows: SearchHit[] = useMemo(() => {
    const ctx: Ctx = { focus: NO_FOCUS, text: textIds };
    const pass = (r: SearchHit) => isDrawn(classify(entities.get(r.id) ?? r, query, ctx));
    return (textOf(query) && textHits ? textHits : ordered).filter(pass);
  }, [entities, ordered, query, textHits, textIds]);

  // the tree: the same filtered, ordered rows, nested under their primary body and flattened to the rows that are open
  const pick = (id: string) => {
    ownSelect.current = id;
    selectObject(id);
  };

  const treeRows = useMemo(() => {
    if (mode !== 'tree') return [];
    // a body that has an entity in the catalog carries it, so the node can select it even when a filter hides its row
    const bodies = TREE_BODIES.map((b) => {
      const entityId = bodyEntityId(b.id);
      return entities.has(entityId) ? { ...b, entityId } : b;
    });
    const recOf = (r: { id: string }) => entities.get(r.id);
    const frameRec = entities.get(frame);
    return buildTreeRows(rows, {
      bodies, frameId: frame, frameBodyId: frameRec ? bodyOf(frameRec) ?? frameRec.bodyId : undefined,
      openAll: filtering, skeleton: !filtering, overrides, kindName: kindLabel, bodyOf: (r) => recOf(r)?.bodyId,
      standsForBody: (r) => { const p = recOf(r)?.provider; return p?.type === 'body' ? p.bodyId : undefined; },
    });
  }, [mode, rows, entities, frame, filtering, overrides]);

  /** the rows pinned at the top of the tree while a row is the first in view: its ancestors (the body chain and the kind group) */
  const stickyOf = useCallback((first: number) => stickyAncestors(treeRows, first), [treeRows]);

  // a body node: opens, and selects its body entity like any other row (the detail panel shows the body, it becomes the
  // frame unless the frame is locked, and the camera flies there)
  const chooseBody = (key: string, entityId?: string) => {
    setOpen(key, true);
    if (entityId) pick(entityId);
  };

  useEffect(() => {
    const own = ownSelect.current === selectedId;
    ownSelect.current = null;
    const rec = selectedId && !own ? entities.get(selectedId) : undefined;
    // a search that leaves the entity out is never cleared: then there is nothing to reveal and the list stays as it is
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
  useEffect(() => setRevealId(null), [filterKey]);
  // collapsing a node (a pinned header too) shrinks the list under the scroll position: keep the node's own row in view
  useEffect(() => {
    const key = collapsedKey.current;
    if (key === null || mode !== 'tree') return;
    collapsedKey.current = null;
    const i = treeRows.findIndex((r) => r.key === key);
    if (i >= 0) listRef.current?.reveal(i);
  }, [treeRows, mode]);

  // ---------------------------------------------------------------- the search field: chips (terms), text, autocomplete

  const chips = useMemo(() => tagTerms(query), [query]);
  /** finished tag words become terms; a launch fits the camera to its members. A typed word takes over a term that is hidden. */
  const addChips = (words: string[]) => {
    const terms = words.map((w) => termFromWord(w)).filter((t): t is Term => !!t);
    if (!terms.length) return;
    addTerms(terms, true);
    for (const t of terms) if (t.key === 'launch' && !t.neg) {
      const ids = launchMembers(launchGroups, t.value);
      if (ids.length) runtime.onFitRequest?.(ids);
    }
  };
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
    } else if (e.key === 'Backspace' && backspaceRemovesChip(input, e.currentTarget.selectionStart, e.currentTarget.selectionEnd, chips.length)) {
      // nothing in front of the caret to delete: the chip before the field goes (the typed text stays)
      e.preventDefault();
      const last = chips[chips.length - 1];
      removeTerm(last.key, last.value, !!last.neg);
    }
  };
  /** CLEAR: the chips, the text and the typed input; the hidden groups stay (SHOW ALL) */
  const clearAll = () => {
    setInput('');
    lastInput.current = '';
    clearQuery();
  };

  const hasHidden = hasHide(query);
  const hidesTerm = (key: TagKey, value: string) => findTerm(query, key, value)?.effect === 'hide';

  // ---------------------------------------------------------------- rows

  const entityRow = (id: string, name: string, kind: string, depth: number, key: string) => {
    const rec = entities.get(id);
    const isFrame = frame === id && !isEarthCentre(id);
    const cls = `row${id === selectedId ? ' sel' : ''}`;
    return (
      <button
        key={key} className={cls} style={{ height: ROW_H, paddingLeft: mode === 'tree' ? 10 + depth * INDENT_PX : undefined }}
        onClick={() => pick(id)}>
        <i className="swatch" style={{ background: `var(--c-${rec ? colorKeyOf(rec) : 'satellites'}, var(--c-satellites))` }} />
        <span className="row-name">{name}</span>
        {isFrame && <span className="row-frame" title="The frame of reference is centred on this object">FRAME</span>}
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
      return entityRow(r.id, rec?.name ?? r.id, rec?.kind ?? '', r.depth, r.key);
    }
    if (r.type === 'group') {
      return (
        <div key={r.key} className="row tree-group" style={{ height: ROW_H, paddingLeft: pad }}>
          <button className="tree-group-name" aria-expanded={r.open} onClick={() => setOpen(r.key, !r.open)}>
            <span className="tree-chev" aria-hidden="true">{r.open ? '▾' : '▸'}</span>
            <span className="row-name">{kindLabel(r.kind)}</span>
          </button>
          <span className="tree-count mono">{r.count.toLocaleString('en-US')}</span>
          {!BODY_CATEGORY_KINDS.has(r.kind) && eyeButton(['type', r.kind.toLowerCase()], `every ${kindLabel(r.kind)}`)}
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
          {r.name.toUpperCase()}
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
    const cls = `tagchip${t.neg ? ' neg' : ''}${hide ? ' hide' : ''}`;
    return (
      <span key={w} className={cls} title={hide ? `Hidden: ${w} is not drawn nor listed` : t.neg ? `Leaves out ${w.slice(1)}` : `Only ${w}`}>
        <span className="tagchip-text">{w}</span>
        {!t.neg && (
          <button
            className="tagchip-btn" aria-pressed={hide} aria-label={`${hide ? 'Show only' : 'Hide'} ${w}`}
            title={hide ? 'Show only these objects instead' : 'Hide these objects (not drawn, not listed) instead of showing only them'}
            onClick={() => setTermEffect(t.key, t.value, hide ? 'only' : 'hide')}>
            <Eye off={hide} />
          </button>
        )}
        <button className="tagchip-btn" aria-label={`Remove ${w}`} title="Remove this tag" onClick={() => removeTerm(t.key, t.value, !!t.neg)}>×</button>
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
        <span className="mono dim">{rows.length.toLocaleString('en-US')}{query.terms.length ? '' : ` / ${entities.size.toLocaleString('en-US')}`}</span>
      </div>
      <div className="search">
        <div className="search-box" onClick={() => inputRef.current?.focus()}>
          {chips.map(chipView)}
          <input
            ref={inputRef} type="text" role="combobox" aria-expanded={suggestOpen} aria-controls="tag-suggest" aria-autocomplete="list"
            aria-activedescendant={suggestOpen ? `tag-opt-${cur}` : undefined}
            placeholder={chips.length ? '' : 'Name or #tag, e.g. type:probe'}
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
            <div>Type <span className="mono">group:</span>, <span className="mono">#</span> or <span className="mono">launch:</span> to list the groups or launches. The eye on a category, a tag chip or a tree header hides it: not drawn, not listed. The search and the tags also thin the scene; HIGHLIGHT dims instead.</div>
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
          {hasHidden && <button className="chip more" onClick={showAll} title="Show every hidden group again">SHOW ALL</button>}
          {(filtering || input !== '') && <button className="chip clear" onClick={clearAll} title="Clear the search: the chips and the typed text (hidden groups stay)">CLEAR</button>}
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="empty">No matching entities.</div>
      ) : (
        mode === 'tree' ? (
          <VirtualList key="tree" ref={listRef} count={treeRows.length} rowHeight={ROW_H} render={renderTree} sticky={stickyOf} />
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
