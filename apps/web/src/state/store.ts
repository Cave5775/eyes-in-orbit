import { create } from 'zustand';
import type {
  Article, ClockSnapshot, ConnectorHealth, DsnSnapshot, EntityRecord, IssArrays, IssFix, Launch, TelemetryPoint,
} from '@eio/core';
import { NO_FILTERS, toggled, type Filters, type LaunchMode, type SearchHit } from '../lib/filters';
import {
  closeFloatWindow, focusFloatWindow, loadFloats, openFloatWindow, saveFloats, setFloatRect, viewportNow,
  type FloatWindow,
} from '../lib/floating';
import { useMemo } from 'react';
import {
  EARTH_CENTRE, bodyCentre, frameChainLabel, centreLabel, frameCrumbs, isEarthCentre, isOrbitableBody, sameCentre,
  type Centre, type Crumb,
} from '../lib/frame';
import { clock, runtime } from './runtime';

export type ConnState = 'connecting' | 'live' | 'reconnecting' | 'offline' | 'mock';

/** One-shot camera request; `nonce` makes repeated requests for the same target distinct. */
export interface FocusRequest {
  id?: string;
  /**
   * centre the view on a frame centre: a body (the Earth is the default home view) or an entity (the camera pivots on
   * it, like following it). Set by `setFrame(..., { fly: true })`.
   */
  centre?: Centre;
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
  selectedId: string | null;
  follow: boolean;
  /**
   * Frame of reference (docs/frames.md): the centre that paths, trails, orbit lines and readouts are relative to.
   * A body or an entity; the Earth by default.
   */
  frame: Centre;
  /** locked: selecting objects never changes the frame (only `setFrame` / `resetView` do) */
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
  select(id: string | null): void;
  focusLaunch(launch: Launch): void;
  /** Camera home view, frame back to the Earth and unlocked. */
  resetView(): void;
  /**
   * Set the frame of reference. `lock`: also set the lock (omitted: unchanged). `fly`: also fly the camera to the
   * centre and follow it (a body centre deselects, as the body tabs always did; an entity centre keeps the selection).
   * An explicit call always applies, locked or not.
   */
  setFrame(centre: Centre, opts?: { lock?: boolean; fly?: boolean }): void;
  setFrameLocked(locked: boolean): void;
  setFollow(follow: boolean): void;
  setQuery(q: string): void;
  setSearchResults(r: SearchHit[] | null): void;
  toggleKind(kind: string): void;
  toggleGroup(group: string): void;
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

export const useStore = create<State>((set, get) => ({
  entities: new Map(),
  selectedId: null,
  follow: true,
  frame: EARTH_CENTRE,
  frameLocked: false,
  focus: null,
  query: '',
  searchResults: null,
  filters: NO_FILTERS,
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
    set({ entities: next });
  },
  openFloat: (url, title) => set((s) => ({ floats: openFloatWindow(s.floats, url, title, viewportNow()) })),
  closeFloat: (url) => set((s) => ({ floats: closeFloatWindow(s.floats, url) })),
  focusFloat: (url) => set((s) => ({ floats: focusFloatWindow(s.floats, url) })),
  setFloatRect: (url, rect) => set((s) => ({ floats: setFloatRect(s.floats, url, rect, viewportNow()) })),
  select(id) {
    // selecting never changes the frame, except: not locked and the object is an orbitable body (a body node of the tree)
    const body = id && !get().frameLocked && isOrbitableBody(id) ? bodyCentre(id) : null;
    if (id && !get().entities.has(id)) {
      if (body) get().setFrame(body, { fly: true }); // a body is not an entity: the frame change flies the camera there
      return;
    }
    set({
      selectedId: id, follow: id !== null, focus: id ? { id, nonce: ++nonce } : get().focus,
      ...(body && !sameCentre(get().frame, body) ? { frame: body } : {}),
    });
  },
  focusLaunch(launch) {
    if (get().entities.has(launch.entityId)) get().select(launch.entityId);
    else if (launch.pad) set({ focus: { lat: launch.pad.latitude, lon: launch.pad.longitude, nonce: ++nonce }, follow: true });
  },
  resetView() {
    set({ selectedId: null, follow: false, frame: EARTH_CENTRE, frameLocked: false, focus: { nonce: ++nonce } });
  },
  setFrame(centre, opts = {}) {
    const next: Partial<State> = {};
    if (!sameCentre(get().frame, centre)) next.frame = centre;
    if (opts.lock !== undefined && opts.lock !== get().frameLocked) next.frameLocked = opts.lock;
    if (opts.fly) {
      if (isEarthCentre(centre)) Object.assign(next, { selectedId: null, follow: false, focus: { nonce: ++nonce } });
      else if (centre.kind === 'body') Object.assign(next, { selectedId: null, follow: true, focus: { centre, nonce: ++nonce } });
      else if (get().entities.has(centre.id)) Object.assign(next, { follow: true, focus: { centre, nonce: ++nonce } });
    }
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
  setLaunchFilter(launchId, memberIds) {
    set((s) => ({ filters: { ...s.filters, launch: launchId } }));
    if (launchId && memberIds?.length) runtime.onFitRequest?.(memberIds);
  },
  setLaunchMode: (launchMode) => set((s) => ({ filters: { ...s.filters, launchMode } })),
  clearFilters: () => set((s) => ({ filters: { ...NO_FILTERS, launchMode: s.filters.launchMode } })),
  setLaunches: (launches) => set({ launches }),
  setNews: (news) => set({ news }),
  setDsn: (dsn) => set({ dsn }),
  setIss: (p) => set((s) => ({ iss: { ...s.iss, ...p } })),
  setHealth: (health, serverTime) => set((s) => ({ health, serverTime: serverTime ?? s.serverTime })),
  setConn: (conn) => set({ conn }),
}));

export type StoreState = State;

/** Selectors for the frame of reference (the phase 2 UI reads these). */
export const selectFrame = (s: StoreState): Centre => s.frame;
export const selectFrameLocked = (s: StoreState): boolean => s.frameLocked;

export interface FrameInfo {
  centre: Centre;
  locked: boolean;
  /** the Earth: the default, nothing changes relative to the pre-frame behaviour */
  isDefault: boolean;
  /** short label: `Moon`, or the entity's name */
  label: string;
  /** breadcrumb, root first: `SUN > EARTH > MOON`, with an entity last for an entity centre; each crumb carries its centre */
  crumbs: Crumb[];
  /** the crumbs joined with ` > ` */
  chain: string;
}

/** Derived description of the current frame for display (breadcrumb, HUD, readout labels). */
export function frameInfoOf(s: Pick<StoreState, 'frame' | 'frameLocked' | 'entities'>): FrameInfo {
  const rec = (id: string) => s.entities.get(id);
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
});
