import { create } from 'zustand';
import { bodyEntityRecords } from '@eio/core';
import type {
  Article, ClockSnapshot, ConnectorHealth, DsnSnapshot, EntityRecord, IssArrays, IssFix, Launch, TelemetryPoint,
} from '@eio/core';
import { perf } from '../lib/perf';
import { Catalog, sameShape } from '../lib/catalog';
import { rankEntities, type SearchHit } from '../lib/filters';
import { REMOTE_TEXT_DELAY_MS, SERVER_SEARCH_MIN, textHitsOf, type MatchFn } from '../lib/text-match';
import {
  NO_QUERY, addTerms, legacyHiddenTerms, parseStoredQuery, removeTerm, sameQuery, serialiseQuery, setTermEffect, textOf, toggleTerm,
  withText, withoutFilter, withoutHidden, type Effect, type Query, type Term, type TermKey,
} from '../lib/query';
import type { TagKey } from '../lib/search-tags';
import {
  closeFloatWindow, focusFloatWindow, loadFloats, openFloatWindow, saveFloats, setFloatRect, toggleMinimized, viewportNow,
  type FloatWindow,
} from '../lib/floating';
import { addRecent, loadRecent, removeRecent, saveRecent, type RecentLink } from '../lib/recent-links';
import { useMemo } from 'react';
import { EARTH_CENTRE, frameChainLabel, centreLabel, frameCrumbs, isEarthCentre, type Centre, type Crumb } from '../lib/frame';
import { frameOnSelect, loadFrame, resolveFrame, saveFrame } from '../lib/frame-store';
import { clock } from './runtime';

export type ConnState = 'connecting' | 'live' | 'reconnecting' | 'offline' | 'mock';

/**
 * One-shot camera request; `nonce` makes repeated requests for the same target distinct. `id`: fly to that entity and follow
 * it (a body is an entity like any other); `lat`/`lon`: a ground point (a launch pad); neither: the home view.
 */
export interface FocusRequest {
  id?: string;
  lat?: number;
  lon?: number;
  nonce: number;
}

export interface IssState {
  fix?: IssFix;
  telemetry: TelemetryPoint[];
  /** SARJ / BGA / attitude from the ISSLIVE feed (absent offline, in mock mode, or before the first sample) */
  arrays?: IssArrays;
}

interface State {
  /** the catalogue: a `Catalog` view (lib/catalog.ts) that changes identity on every merge without copying; a test may set a plain Map */
  entities: ReadonlyMap<string, EntityRecord>;
  /**
   * The focus is four fields: what is selected (and shown in the detail panel), the frame of reference (an entity id, the
   * Earth's `body-earth` by default), the frame lock and whether the camera follows the selection. `focus` is only the
   * one-shot camera request that goes with a change of them. Every route (tree, breadcrumb, scene, popup, DSN, search,
   * labels) changes them through `selectObject`.
   */
  selectedId: string | null;
  follow: boolean;
  /** Frame of reference (docs/frames.md): the centre that paths, trails, orbit lines and readouts are relative to. */
  frame: Centre;
  /** locked: selecting objects never changes the frame (only `setFrame`, `resetView` and a vanished frame entity do) */
  frameLocked: boolean;
  focus: FocusRequest | null;
  /**
   * What the search field, the entity list, the tree and the scene show (lib/query.ts): the tag terms (chips) with their
   * effect, only or hide, and the typed text as a term. The tag terms are remembered (`localStorage['eio.query']`).
   */
  query: Query;
  /** HIGHLIGHT: dim everything but the selection, its related objects and what the query matches instead of hiding it. Remembered. */
  highlight: boolean;
  /** the entities the query's text matches, best first (local ranking of the whole table); null without text */
  textHits: SearchHit[] | null;
  /** the ids of `textHits`: the `ctx.text` of `classify` */
  textIds: ReadonlySet<string> | null;
  launches: Launch[];
  news: Article[];
  dsn: DsnSnapshot | null;
  iss: IssState;
  health: ConnectorHealth[];
  serverTime: number | null;
  conn: ConnState;
  clock: ClockSnapshot;
  /** pop-out stream windows, in stacking order; they live here so tab and selection changes do not touch them */
  floats: FloatWindow[];

  /**
   * Merge records into the catalogue, or replace it (`replace`). `partial` = more pages of the same full load follow (lib/paging.ts):
   * the remembered frame is not restored yet, because its entity may be on a later page; `catalogLoaded` does it.
   */
  upsertEntities(records: EntityRecord[], replace?: boolean, partial?: boolean): void;
  /**
   * What the last merge changed: the records it carried and the catalogue map they were merged into (`base`). A consumer that last
   * saw `base` can apply just `records` instead of walking the whole catalogue; anyone else takes `entities`. Null after a replace.
   */
  entityChange: { records: EntityRecord[]; base: ReadonlyMap<string, EntityRecord> } | null;
  /**
   * Bumped when a merge changes what a LIST of the catalogue shows (a record added, renamed, regrouped ...; lib/catalog.ts
   * `sameShape`), not when SGP4 elements alone change. The Objects tree, list and counts rebuild on this, not on every merge.
   */
  catalogShape: number;
  /** The full catalogue has arrived (every page): restore the remembered frame, once. */
  catalogLoaded(): void;
  /** Pop a stream out into a floating window (no-op at the cap; focuses it when already open). False when refused. */
  openFloat(url: string, title: string): boolean;
  /** "Watch a livestream" history (localStorage 'eio.recent-links.v1'), most recent first. */
  recentLinks: RecentLink[];
  /** Remember a link that opened successfully (moves it to the front). */
  rememberLink(text: string, title: string): void;
  forgetLink(url: string): void;
  clearRecentLinks(): void;
  /** Close a floating window (the Stream tab's "Dock back" uses this too; the tab then plays the stream again). */
  closeFloat(url: string): void;
  focusFloat(url: string): void;
  /** Minimize a window to its title-bar tab or restore it (the player stays mounted and keeps playing). Still counts toward the cap. */
  toggleFloatMinimized(url: string): void;
  /** Move or resize a floating window; the store clamps it to the viewport and keeps 16:9. */
  setFloatRect(url: string, rect: { x: number; y: number; w: number }): void;
  /**
   * THE selection action; every route calls it. With an id (an entity of the catalog; unknown ids are ignored): it selects the
   * entity, makes it the frame when it is orbitable (a body entity or `attrs.orbitable`) unless the frame is locked, turns
   * follow on and emits ONE focus request for it (`fly`, default true; false selects without moving the camera or touching
   * follow). With null (deselect): nothing selected, follow off, the frame back to the Earth unless it is locked, no camera
   * request. A locked frame keeps the frame; the selection and the camera still go to the selected object.
   */
  selectObject(id: string | null, opts?: { fly?: boolean }): void;
  /** Select a launch: its entity (as `selectObject`), or its pad's ground point when it has no entity. */
  focusLaunch(launch: Launch): void;
  /** Home view: deselect, follow off, the frame back to the Earth, unlocked, and the camera back to the Earth. */
  resetView(): void;
  /**
   * Set the frame of reference to an entity of the catalog (the lock button: the selected object becomes the frame and stays
   * it). Only the frame and, when `lock` is given, the lock change: no selection, follow or camera request. An explicit call
   * applies, locked or not.
   */
  setFrame(id: Centre, lock?: boolean): void;
  setFrameLocked(locked: boolean): void;
  setFollow(follow: boolean): void;
  setQuery(q: Query): void;
  /** The chip / eye click on `key:value`: add it with `effect` (default only), remove it when it has that effect, else switch it. */
  toggleTerm(key: TagKey, value: string, effect?: Effect): void;
  /** Switch the effect of a term (an only chip to hide and back). */
  setTermEffect(key: TermKey, value: string, effect: Effect, neg?: boolean): void;
  removeTerm(key: TermKey, value: string, neg?: boolean): void;
  /** Add tag terms (the chips the search field commits); terms already there are left alone. */
  addTerms(terms: readonly Term[], override?: boolean): void;
  /** The typed text of the search field (the text term; '' removes it). */
  setText(text: string): void;
  /** CLEAR: no only term and no text; the hide terms stay unless `hidden` (SHOW ALL clears those alone). */
  clearQuery(hidden?: boolean): void;
  /** SHOW ALL: no hide term left. */
  showAll(): void;
  setHighlight(on: boolean): void;
  setLaunches(l: Launch[]): void;
  setNews(n: Article[]): void;
  setDsn(d: DsnSnapshot): void;
  setIss(p: Partial<IssState>): void;
  setHealth(h: ConnectorHealth[], serverTime?: number): void;
  setConn(c: ConnState): void;
}

let nonce = 0;

const QUERY_KEY = 'eio.query';
/** the old key of the hidden groups: read once into hide terms, then deleted */
const LEGACY_HIDDEN_KEY = 'eio.hidden';
const HIGHLIGHT_KEY = 'eio.highlight';

/**
 * The tag terms remembered in this browser (empty when storage is blocked or the value is malformed); the old `cat` and `kind`
 * tags come back as `type`. A leftover `eio.hidden` becomes hide terms once and is deleted.
 */
function loadQuery(): Query {
  try {
    const stored = localStorage.getItem(QUERY_KEY);
    let q = parseStoredQuery(stored);
    // an old `cat` / `kind` tag was migrated to `type`: write it back once so the old keys are gone from storage
    if (stored !== null && serialiseQuery(q) !== stored) saveQuery(q);
    const legacy = localStorage.getItem(LEGACY_HIDDEN_KEY);
    if (legacy !== null) {
      q = addTerms(q, legacyHiddenTerms(legacy));
      saveQuery(q);
      localStorage.removeItem(LEGACY_HIDDEN_KEY);
    }
    return q;
  } catch {
    return NO_QUERY;
  }
}
function saveQuery(q: Query): void {
  try {
    localStorage.setItem(QUERY_KEY, serialiseQuery(q));
  } catch { /* private window: the choice just is not remembered */ }
}
function loadHighlight(): boolean {
  try {
    return localStorage.getItem(HIGHLIGHT_KEY) === 'on';
  } catch {
    return false;
  }
}
function saveHighlight(on: boolean): void {
  try {
    localStorage.setItem(HIGHLIGHT_KEY, on ? 'on' : 'off');
  } catch { /* private window: the choice just is not remembered */ }
}

type TextState = Pick<State, 'textHits' | 'textIds'>;
const NO_TEXT: TextState = { textHits: null, textIds: null };
/** What a typed text matches while the server has not answered yet: nothing (the previous answer is kept when there is one). */
const EMPTY_TEXT: TextState = { textHits: [], textIds: new Set() };

/**
 * The server's text search (`GET /api/match`, an FTS5 index), set by the data layer when a server is there; null (the offline
 * mock) means every search is local. A catalogue of `SERVER_SEARCH_MIN` records or more asks it instead of ranking in the browser
 * (docs/perf.md: 83 ms a query at 100 k, 1 s at 1 M, on the main thread).
 */
let textMatcher: MatchFn | null = null;
export const setTextMatcher = (fn: MatchFn | null): void => { textMatcher = fn; cancelRemoteText(); };
let remoteSeq = 0;
let remoteTimer: ReturnType<typeof setTimeout> | undefined;
function cancelRemoteText(): void {
  remoteSeq++;
  clearTimeout(remoteTimer);
}

/** Every entity the text matches, best first, ranked here over the whole catalogue (small catalogues, no server, a failed or truncated answer). */
function localText(text: string, entities: ReadonlyMap<string, EntityRecord>): TextState {
  const t0 = perf.on ? performance.now() : 0;
  const textHits = rankEntities(entities.values(), text, Infinity);
  const textIds = new Set(textHits.map((h) => h.id));
  if (perf.on) perf.time('textSearch', performance.now() - t0);
  return { textHits, textIds };
}

/** Ask the server for `text` (after a short pause for typing); the answer replaces the text state if it is still the current one. */
function askServer(text: string, match: MatchFn): void {
  cancelRemoteText();
  const mine = remoteSeq;
  remoteTimer = setTimeout(() => {
    const done = (build: (entities: ReadonlyMap<string, EntityRecord>) => TextState) => {
      if (mine !== remoteSeq) return; // a newer query, or the text was cleared
      const s = useStore.getState();
      if (textOf(s.query) !== text) return;
      useStore.setState(build(s.entities));
    };
    match(text).then(
      (a) => done((entities) => {
        // an answer cut off by the server's cap is incomplete: rank here instead (the records are all here)
        if (a.truncated) return localText(text, entities);
        const t0 = perf.on ? performance.now() : 0;
        const textHits = textHitsOf(a.ids, entities);
        const textIds = new Set(textHits.map((h) => h.id));
        if (perf.on) perf.time('textSearch', performance.now() - t0);
        return { textHits, textIds };
      }),
      () => done((entities) => localText(text, entities)), // no answer: the browser can still do it
    );
  }, REMOTE_TEXT_DELAY_MS);
}

/** The text term looked up once, here, not per frame: every entity the text matches, best first. `current` is kept while a server answer is awaited. */
function lookUpText(text: string, entities: ReadonlyMap<string, EntityRecord>, current: TextState = NO_TEXT): TextState {
  if (!text) {
    cancelRemoteText();
    return NO_TEXT;
  }
  if (textMatcher && entities.size >= SERVER_SEARCH_MIN) {
    askServer(text, textMatcher);
    // only the two text fields: `current` may be the whole store state, which must not be spread into a patch
    return current.textIds ? { textHits: current.textHits, textIds: current.textIds } : EMPTY_TEXT;
  }
  cancelRemoteText();
  return localText(text, entities);
}
/** the remembered frame is restored once, when the first full catalog arrives */
let frameRestorePending = true;
/** Test hook: restore the remembered frame again at the next full catalog load. */
export const armFrameRestore = (): void => { frameRestorePending = true; };

/**
 * Put the remembered frame (`localStorage['eio.frame']`) back: unlocked, selecting it (so the camera flies there) when it is
 * not the Earth. A frame the user already changed before the catalog arrived wins; an unknown or stale one (a removed entity)
 * is replaced by the Earth.
 */
function restoreFrame(): void {
  const s = useStore.getState();
  if (!isEarthCentre(s.frame)) return;
  const target = resolveFrame(loadFrame(), (id) => s.entities.get(id));
  saveFrame(target); // a stale value is overwritten
  if (isEarthCentre(target)) return;
  s.setFrame(target, false);
  s.selectObject(target);
}

export const useStore = create<State>((set, get) => ({
  entities: Catalog.of(),
  selectedId: null,
  follow: false,
  frame: EARTH_CENTRE,
  frameLocked: false,
  focus: null,
  query: loadQuery(),
  highlight: loadHighlight(),
  ...NO_TEXT,
  launches: [],
  news: [],
  dsn: null,
  iss: { telemetry: [] },
  health: [],
  serverTime: null,
  conn: 'connecting',
  clock: clock.snapshot(),
  floats: loadFloats(),
  recentLinks: loadRecent(),
  entityChange: null,
  catalogShape: 0,

  upsertEntities(records, replace = false, partial = false) {
    const t0 = perf.on ? performance.now() : 0;
    // a merge writes into the shared map and hands out a new view (lib/catalog.ts): no copy of the catalogue; `prev` is read
    // before, since an older view sees the merge too
    const prev = get().entities;
    const prevSize = prev.size;
    const shapeChanged = replace || records.some((r) => !sameShape(prev.get(r.id), r));
    const next = replace ? Catalog.of(records) : (prev instanceof Catalog ? prev : Catalog.of(prev.values())).merged(records);
    const patch: Partial<State> = { entities: next, entityChange: replace ? null : { records, base: prev } };
    if (shapeChanged) patch.catalogShape = get().catalogShape + 1;
    if (replace && next.size > 0) {
      // a full catalog that no longer has the selected entity (or the frame's) leaves nothing to point at
      const { selectedId, frame } = get();
      if (selectedId !== null && !next.has(selectedId)) Object.assign(patch, { selectedId: null, follow: false });
      if (!isEarthCentre(frame) && !next.has(frame)) Object.assign(patch, { frame: EARTH_CENTRE, frameLocked: false });
    }
    // the text term follows the catalog (the ids it matches), but only when the catalog changed in size or was replaced
    const text = textOf(get().query);
    if (text && (replace || next.size !== prevSize)) Object.assign(patch, lookUpText(text, next, get()));
    set(patch);
    if (perf.on) {
      perf.time('ingest', performance.now() - t0);
      perf.storeUpdate();
      if (!perf.firstIngestMs) perf.firstIngestMs = performance.now();
    }
    // the first full catalog is the moment to restore the remembered frame (its entity or body must exist)
    if (replace && !partial && frameRestorePending && next.size > 0) {
      frameRestorePending = false;
      restoreFrame();
    }
  },
  catalogLoaded() {
    if (frameRestorePending && get().entities.size > 0) {
      frameRestorePending = false;
      restoreFrame();
    }
  },
  openFloat(url, title) {
    const s = get();
    const floats = openFloatWindow(s.floats, url, title, viewportNow());
    if (!floats.some((f) => f.url === url)) return false; // refused: the cap or not a floatable URL
    if (floats !== s.floats) set({ floats });
    return true;
  },
  rememberLink: (text, title) => set((s) => ({ recentLinks: addRecent(s.recentLinks, text, title, Date.now()) })),
  forgetLink: (url) => set((s) => ({ recentLinks: removeRecent(s.recentLinks, url) })),
  clearRecentLinks: () => set({ recentLinks: [] }),
  toggleFloatMinimized: (url) => set((s) => ({ floats: toggleMinimized(s.floats, url) })),
  closeFloat: (url) => set((s) => ({ floats: closeFloatWindow(s.floats, url) })),
  focusFloat: (url) => set((s) => ({ floats: focusFloatWindow(s.floats, url) })),
  setFloatRect: (url, rect) => set((s) => ({ floats: setFloatRect(s.floats, url, rect, viewportNow()) })),
  selectObject(id, opts = {}) {
    const s = get();
    if (id === null) {
      set({ selectedId: null, follow: false, frame: s.frameLocked ? s.frame : EARTH_CENTRE });
      return;
    }
    const rec = s.entities.get(id);
    if (!rec) return;
    const fly = opts.fly ?? true;
    set({
      selectedId: id,
      frame: frameOnSelect(rec, s.frameLocked) ?? s.frame,
      ...(fly ? { follow: true, focus: { id, nonce: ++nonce } } : {}),
    });
  },
  focusLaunch(launch) {
    const s = get();
    if (s.entities.has(launch.entityId)) s.selectObject(launch.entityId);
    else if (launch.pad) {
      s.selectObject(null);
      set({ follow: true, focus: { lat: launch.pad.latitude, lon: launch.pad.longitude, nonce: ++nonce } });
    }
  },
  resetView() {
    set({ selectedId: null, follow: false, frame: EARTH_CENTRE, frameLocked: false, focus: { nonce: ++nonce } });
  },
  setFrame(id, lock) {
    const s = get();
    if (!isEarthCentre(id) && !s.entities.has(id)) return;
    const next: Partial<State> = {};
    if (s.frame !== id) next.frame = id;
    if (lock !== undefined && lock !== s.frameLocked) next.frameLocked = lock;
    set(next);
  },
  setFrameLocked(locked) {
    if (locked !== get().frameLocked) set({ frameLocked: locked });
  },
  setFollow: (follow) => set({ follow }),
  setQuery: (query) => set((s) => {
    if (sameQuery(s.query, query)) return s;
    const text = textOf(query);
    return { query, ...(text === textOf(s.query) ? {} : lookUpText(text, s.entities, s)) };
  }),
  toggleTerm: (key, value, effect = 'only') => get().setQuery(toggleTerm(get().query, key, value, effect)),
  setTermEffect: (key, value, effect, neg = false) => get().setQuery(setTermEffect(get().query, key, value, effect, neg)),
  removeTerm: (key, value, neg = false) => get().setQuery(removeTerm(get().query, key, value, neg)),
  addTerms: (terms, override = false) => get().setQuery(addTerms(get().query, terms, override)),
  setText: (text) => get().setQuery(withText(get().query, text)),
  clearQuery: (hidden = false) => get().setQuery(hidden ? NO_QUERY : withoutFilter(get().query)),
  showAll: () => get().setQuery(withoutHidden(get().query)),
  setHighlight: (highlight) => set((s) => (s.highlight === highlight ? s : { highlight })),
  setLaunches: (launches) => set({ launches }),
  setNews: (news) => set({ news }),
  setDsn: (dsn) => set({ dsn }),
  setIss: (p) => set((s) => ({ iss: { ...s.iss, ...p } })),
  setHealth: (health, serverTime) => set((s) => ({ health, serverTime: serverTime ?? s.serverTime })),
  setConn: (conn) => set({ conn }),
}));

export type StoreState = State;

/** Body entities as generated from the registry: they name the Earth's crumb before the catalog has arrived. */
const BODY_FALLBACK = new Map(bodyEntityRecords().map((r) => [r.id, r]));

/** Selectors for the frame of reference. */
export const selectFrame = (s: StoreState): Centre => s.frame;
export const selectFrameLocked = (s: StoreState): boolean => s.frameLocked;

export interface FrameInfo {
  centre: Centre;
  locked: boolean;
  /** the Earth: the default, nothing changes relative to the pre-frame behaviour */
  isDefault: boolean;
  /** short label: the centre entity's name (`Moon`) */
  label: string;
  /** breadcrumb, root first: `Sun > Earth > Moon`, with the entity last for a non-body centre; each crumb carries its entity id */
  crumbs: Crumb[];
  /** the crumbs joined with ` > ` */
  chain: string;
}

/** Derived description of the current frame for display (breadcrumb, HUD, readout labels). */
export function frameInfoOf(s: Pick<StoreState, 'frame' | 'frameLocked' | 'entities'>): FrameInfo {
  const rec = (id: string) => s.entities.get(id) ?? BODY_FALLBACK.get(id);
  return {
    centre: s.frame, locked: s.frameLocked, isDefault: isEarthCentre(s.frame), label: centreLabel(s.frame, rec),
    crumbs: frameCrumbs(s.frame, rec), chain: frameChainLabel(s.frame, rec),
  };
}

/** React hook: the current frame, its lock and labels. Re-renders when the frame, the lock or the entity table changes. */
export function useFrameInfo(): FrameInfo {
  const frame = useStore(selectFrame);
  const frameLocked = useStore(selectFrameLocked);
  const entities = useStore((s) => s.entities);
  return useMemo(() => frameInfoOf({ frame, frameLocked, entities }), [frame, frameLocked, entities]);
}

clock.subscribe((snap) => useStore.setState({ clock: snap }));
useStore.subscribe((s, p) => {
  if (s.floats !== p.floats) saveFloats(s.floats);
  if (s.recentLinks !== p.recentLinks) saveRecent(s.recentLinks);
  if (s.frame !== p.frame) saveFrame(s.frame); // the lock is not remembered, only the centre
  if (s.query !== p.query && serialiseQuery(s.query) !== serialiseQuery(p.query)) saveQuery(s.query); // the typed text is not remembered
  if (s.highlight !== p.highlight) saveHighlight(s.highlight);
});
