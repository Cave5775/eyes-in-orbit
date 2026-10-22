import { create } from 'zustand';
import type {
  Article, ClockSnapshot, ConnectorHealth, DsnSnapshot, EntityRecord, IssFix, Launch, TelemetryPoint,
} from '@eio/core';
import { NO_FILTERS, toggled, type Filters, type SearchHit } from '../lib/filters';
import { clock } from './runtime';

export type ConnState = 'connecting' | 'live' | 'reconnecting' | 'offline' | 'mock';

/** One-shot camera request; `nonce` makes repeated requests for the same target distinct. */
export interface FocusRequest {
  id?: string;
  lat?: number;
  lon?: number;
  nonce: number;
}

export interface IssState {
  fix?: IssFix;
  telemetry: TelemetryPoint[];
}

interface State {
  entities: Map<string, EntityRecord>;
  selectedId: string | null;
  follow: boolean;
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

  upsertEntities(records: EntityRecord[], replace?: boolean): void;
  select(id: string | null): void;
  focusLaunch(launch: Launch): void;
  resetView(): void;
  setFollow(follow: boolean): void;
  setQuery(q: string): void;
  setSearchResults(r: SearchHit[] | null): void;
  toggleKind(kind: string): void;
  toggleGroup(group: string): void;
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

  upsertEntities(records, replace = false) {
    const next = replace ? new Map<string, EntityRecord>() : new Map(get().entities);
    for (const r of records) next.set(r.id, r);
    set({ entities: next });
  },
  select(id) {
    if (id && !get().entities.has(id)) return;
    set({ selectedId: id, follow: id !== null, focus: id ? { id, nonce: ++nonce } : get().focus });
  },
  focusLaunch(launch) {
    if (get().entities.has(launch.entityId)) get().select(launch.entityId);
    else if (launch.pad) set({ focus: { lat: launch.pad.latitude, lon: launch.pad.longitude, nonce: ++nonce }, follow: true });
  },
  resetView() {
    set({ selectedId: null, follow: false, focus: { nonce: ++nonce } });
  },
  setFollow: (follow) => set({ follow }),
  setQuery: (query) => set({ query }),
  setSearchResults: (searchResults) => set({ searchResults }),
  toggleKind: (k) => set((s) => ({ filters: { ...s.filters, kinds: toggled(s.filters.kinds, k) } })),
  toggleGroup: (g) => set((s) => ({ filters: { ...s.filters, groups: toggled(s.filters.groups, g) } })),
  clearFilters: () => set({ filters: NO_FILTERS }),
  setLaunches: (launches) => set({ launches }),
  setNews: (news) => set({ news }),
  setDsn: (dsn) => set({ dsn }),
  setIss: (p) => set((s) => ({ iss: { ...s.iss, ...p } })),
  setHealth: (health, serverTime) => set((s) => ({ health, serverTime: serverTime ?? s.serverTime })),
  setConn: (conn) => set({ conn }),
}));

clock.subscribe((snap) => useStore.setState({ clock: snap }));
