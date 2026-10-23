import { create } from 'zustand';
import type {
  Article, ClockSnapshot, ConnectorHealth, DsnSnapshot, EntityRecord, IssArrays, IssFix, Launch, TelemetryPoint,
} from '@eio/core';
import { NO_FILTERS, toggled, type Filters, type LaunchMode, type SearchHit } from '../lib/filters';
import {
  closeFloatWindow, focusFloatWindow, loadFloats, openFloatWindow, saveFloats, setFloatRect, viewportNow,
  type FloatWindow,
} from '../lib/floating';
import type { RefBody } from '../lib/ref-body';
import { clock, runtime } from './runtime';

export type ConnState = 'connecting' | 'live' | 'reconnecting' | 'offline' | 'mock';

/** One-shot camera request; `nonce` makes repeated requests for the same target distinct. */
export interface FocusRequest {
  id?: string;
  /** centre the view on a body ('EARTH' is the default home view) */
  body?: RefBody;
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
  /** body the view is centred on and readouts are measured from */
  refBody: RefBody;
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
  resetView(): void;
  /** Centre the view on a body (and measure readouts from it). Deselects. */
  setRefBody(body: RefBody): void;
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
  refBody: 'EARTH',
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
    if (id && !get().entities.has(id)) return;
    set({ selectedId: id, follow: id !== null, focus: id ? { id, nonce: ++nonce } : get().focus });
  },
  focusLaunch(launch) {
    if (get().entities.has(launch.entityId)) get().select(launch.entityId);
    else if (launch.pad) set({ focus: { lat: launch.pad.latitude, lon: launch.pad.longitude, nonce: ++nonce }, follow: true });
  },
  resetView() {
    set({ selectedId: null, follow: false, refBody: 'EARTH', focus: { nonce: ++nonce } });
  },
  setRefBody(body) {
    if (body === 'EARTH') get().resetView();
    else set({ selectedId: null, follow: true, refBody: body, focus: { body, nonce: ++nonce } });
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

clock.subscribe((snap) => useStore.setState({ clock: snap }));
useStore.subscribe((s, p) => {
  if (s.floats !== p.floats) saveFloats(s.floats);
});
