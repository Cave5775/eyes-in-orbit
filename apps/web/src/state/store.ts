import { create } from 'zustand';
import { bodyEntityRecords } from '@eio/core';
import type {
  Article, ClockSnapshot, ConnectorHealth, DsnSnapshot, EntityRecord, IssArrays, IssFix, Launch, TelemetryPoint,
} from '@eio/core';
import { NO_FILTERS, toggled, type Filters, type LaunchMode, type SearchHit } from '../lib/filters';
import {
  NO_HIDDEN, parseHidden, serialiseHidden, tagTokens, toggleHidden, type HiddenTags, type TagFilter, type TagKey,
} from '../lib/search-tags';
import {
  closeFloatWindow, focusFloatWindow, loadFloats, openFloatWindow, saveFloats, setFloatRect, viewportNow,
  type FloatWindow,
} from '../lib/floating';
import { useMemo } from 'react';
import { EARTH_CENTRE, frameChainLabel, centreLabel, frameCrumbs, isEarthCentre, type Centre, type Crumb } from '../lib/frame';
import { frameOnSelect, loadFrame, resolveFrame, saveFrame } from '../lib/frame-store';
import { clock, runtime } from './runtime';

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
  entities: Map<string, EntityRecord>;
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
  query: string;
  searchResults: SearchHit[] | null;
  filters: Filters;
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

  upsertEntities(records: EntityRecord[], replace?: boolean): void;
  /** Pop a stream out into a floating window (no-op at the cap; focuses it when already open). */
  openFloat(url: string, title: string): void;
  /** Close a floating window, or dock it back to its tab (both remove it from the floating list). */
  closeFloat(url: string): void;
  focusFloat(url: string): void;
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
  setQuery(q: string): void;
  setSearchResults(r: SearchHit[] | null): void;
  toggleKind(kind: string): void;
  toggleGroup(group: string): void;
  /** The tags of the search field (`group:starlink`, `-kind:debris`...); they filter the list and the scene. */
  setTags(tags: TagFilter): void;
  /** Hide (or with `on` false show again) the entities of a group, `key:value` as in the search tags, e.g. `cat`, `debris`. */
  toggleHidden(key: TagKey, value: string, on?: boolean): void;
  /** Show every hidden group again. */
  showAll(): void;
  /** Select a launch group (`YYYY-NNN`) or clear it with null; `memberIds` are passed to `runtime.onFitRequest`. */
  setLaunchFilter(launchId: string | null, memberIds?: string[]): void;
  setLaunchMode(mode: LaunchMode): void;
  clearFilters(): void;
  setLaunches(l: Launch[]): void;
  setNews(n: Article[]): void;
  setDsn(d: DsnSnapshot): void;
  setIss(p: Partial<IssState>): void;
  setHealth(h: ConnectorHealth[], serverTime?: number): void;
  setConn(c: ConnState): void;
}

let nonce = 0;

const HIDDEN_KEY = 'eio.hidden';
/** the hidden groups remembered in this browser (nothing hidden when storage is blocked or the value is malformed) */
function loadHidden(): HiddenTags {
  try {
    return parseHidden(localStorage.getItem(HIDDEN_KEY));
  } catch {
    return NO_HIDDEN;
  }
}
function saveHidden(h: HiddenTags): void {
  try {
    localStorage.setItem(HIDDEN_KEY, serialiseHidden(h));
  } catch { /* private window: the choice just is not remembered */ }
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
  entities: new Map(),
  selectedId: null,
  follow: false,
  frame: EARTH_CENTRE,
  frameLocked: false,
  focus: null,
  query: '',
  searchResults: null,
  filters: { ...NO_FILTERS, hidden: loadHidden() },
  launches: [],
  news: [],
  dsn: null,
  iss: { telemetry: [] },
  health: [],
  serverTime: null,
  conn: 'connecting',
  clock: clock.snapshot(),
  floats: loadFloats(),

  upsertEntities(records, replace = false) {
    const next = replace ? new Map<string, EntityRecord>() : new Map(get().entities);
    for (const r of records) next.set(r.id, r);
    const patch: Partial<State> = { entities: next };
    if (replace && next.size > 0) {
      // a full catalog that no longer has the selected entity (or the frame's) leaves nothing to point at
      const { selectedId, frame } = get();
      if (selectedId !== null && !next.has(selectedId)) Object.assign(patch, { selectedId: null, follow: false });
      if (!isEarthCentre(frame) && !next.has(frame)) Object.assign(patch, { frame: EARTH_CENTRE, frameLocked: false });
    }
    set(patch);
    // the first full catalog is the moment to restore the remembered frame (its entity or body must exist)
    if (replace && frameRestorePending && next.size > 0) {
      frameRestorePending = false;
      restoreFrame();
    }
  },
  openFloat: (url, title) => set((s) => ({ floats: openFloatWindow(s.floats, url, title, viewportNow()) })),
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
  setQuery: (query) => set({ query }),
  setSearchResults: (searchResults) => set({ searchResults }),
  toggleKind: (k) => set((s) => ({ filters: { ...s.filters, kinds: toggled(s.filters.kinds, k) } })),
  toggleGroup: (g) => set((s) => ({ filters: { ...s.filters, groups: toggled(s.filters.groups, g) } })),
  setTags: (tags) => set((s) => (tagTokens(s.filters.tags ?? { include: {}, exclude: {} }).join(' ') === tagTokens(tags).join(' ') ? s : { filters: { ...s.filters, tags } })),
  toggleHidden: (key, value, on) => set((s) => {
    const hidden = toggleHidden(s.filters.hidden ?? NO_HIDDEN, key, value, on);
    return hidden === s.filters.hidden ? s : { filters: { ...s.filters, hidden } };
  }),
  showAll: () => set((s) => (s.filters.hidden && Object.keys(s.filters.hidden).length ? { filters: { ...s.filters, hidden: NO_HIDDEN } } : s)),
  setLaunchFilter(launchId, memberIds) {
    set((s) => ({ filters: { ...s.filters, launch: launchId } }));
    if (launchId && memberIds?.length) runtime.onFitRequest?.(memberIds);
  },
  setLaunchMode: (launchMode) => set((s) => ({ filters: { ...s.filters, launchMode } })),
  clearFilters: () => set((s) => ({ filters: { ...NO_FILTERS, launchMode: s.filters.launchMode, hidden: s.filters.hidden } })),
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
  if (s.frame !== p.frame) saveFrame(s.frame); // the lock is not remembered, only the centre
  if (s.filters.hidden !== p.filters.hidden) saveHidden(s.filters.hidden ?? NO_HIDDEN);
});
