import { deriveMissionState, type CompositeSegment, type Launch, type StreamLink } from '@eio/core';
import type { Connector } from '../connector';
import type { Hub, NewEntity } from '../hub';
import { matchTrajectory, trajectorySamples, type Trajectory } from '../trajectory';

const POLL_MS = 10 * 60_000;
const PHASE_TICK_MS = 15_000;
const UPCOMING_TTL_MS = 9 * 60_000;
/** past launches change rarely; a longer TTL keeps the anonymous tier (~15 req/h) comfortable */
const PREVIOUS_TTL_MS = 55 * 60_000;
const DAY_MS = 86_400_000;

type Json = Record<string, any>;

export function streamKind(url: string): StreamLink['kind'] {
  let host = '';
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch { /* fall through to web */ }
  if (host === 'youtube.com' || host === 'youtu.be' || host.endsWith('.youtube.com')) return 'youtube';
  if (host === 'x.com' || host === 'twitter.com') return 'x';
  if (host.endsWith('nasa.gov') || host === 'plus.nasa.gov') return 'nasa-tv';
  return 'web';
}

/** LL2 returns `vidURLs` in 2.2.0 and `vid_urls` (always empty) next to it; accept either. Official webcasts first. */
export function normalizeStreams(raw: Json, nowMs: number): StreamLink[] {
  const vids: Json[] = (raw.vidURLs?.length ? raw.vidURLs : raw.vid_urls) ?? [];
  return vids
    .map((v) => (typeof v === 'string' ? { url: v } : v) as Json)
    .filter((v) => typeof v.url === 'string')
    .sort((a, b) => (a.type?.id === 1 ? -1 : 0) - (b.type?.id === 1 ? -1 : 0) || (b.priority ?? 0) - (a.priority ?? 0))
    .map((v): StreamLink => {
      const start = v.start_time ? Date.parse(v.start_time) : NaN;
      const end = v.end_time ? Date.parse(v.end_time) : start + 6 * 3600_000;
      return {
        title: [v.publisher, v.title].filter(Boolean).join(': ') || v.url,
        url: v.url,
        kind: streamKind(v.url),
        live: raw.webcast_live ? true : Number.isFinite(start) ? nowMs >= start - 15 * 60_000 && nowMs <= end : undefined,
      };
    });
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' && v.trim() === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : undefined;
};

export function normalizeLaunch(raw: Json, nowMs = Date.now()): Launch {
  const status = raw.status ?? {};
  const orbit = raw.mission?.orbit;
  const lat = num(raw.pad?.latitude), lon = num(raw.pad?.longitude);
  const state = deriveMissionState({ statusId: status.id, netMs: Date.parse(raw.net), nowMs });
  return {
    id: raw.id,
    name: raw.name,
    status: { id: status.id, name: status.name, abbrev: status.abbrev },
    net: raw.net,
    windowStart: raw.window_start ?? undefined,
    windowEnd: raw.window_end ?? undefined,
    provider: raw.launch_service_provider?.name,
    vehicle: raw.rocket?.configuration?.full_name ?? raw.rocket?.configuration?.name,
    mission: raw.mission ? {
      name: raw.mission.name, type: raw.mission.type ?? undefined, description: raw.mission.description ?? undefined,
      orbit: orbit?.abbrev ?? orbit?.name ?? undefined,
    } : undefined,
    pad: lat !== undefined && lon !== undefined
      ? { name: raw.pad.name, latitude: lat, longitude: lon, location: raw.pad.location?.name, countryCode: raw.pad.location?.country_code }
      : undefined,
    streams: normalizeStreams(raw, nowMs),
    image: typeof raw.image === 'string' ? raw.image : raw.image?.image_url ?? undefined,
    phase: state.phase,
    hold: state.hold,
    entityId: `launch-${raw.id}`,
  };
}

/** `launch-<id>` entity: geodetic at the pad, or pad -> sampled ascent composite when a trajectory exists. */
export function launchEntity(launch: Launch, trajectory?: Trajectory): NewEntity {
  const netMs = Date.parse(launch.net);
  const pad = launch.pad;
  let provider: NewEntity['provider'];
  if (pad) {
    const geodetic = { type: 'geodetic', bodyId: 'EARTH', latDeg: pad.latitude, lonDeg: pad.longitude, altKm: 0 } as const;
    if (trajectory && Number.isFinite(netMs)) {
      const samples = trajectorySamples(trajectory, { latDeg: pad.latitude, lonDeg: pad.longitude }, netMs);
      const segments: CompositeSegment[] = [
        { fromMs: netMs - 30 * DAY_MS, toMs: netMs - 1, phase: 'pad', spec: geodetic },
        { fromMs: netMs, toMs: samples[samples.length - 1][0], phase: 'ascent', spec: { type: 'sampled', frame: 'EARTH:fixed', samples } },
      ];
      provider = { type: 'composite', segments };
    } else provider = geodetic;
  }
  return {
    id: launch.entityId,
    name: launch.name,
    kind: 'launch_vehicle',
    bodyId: 'EARTH',
    aliases: { ll2: launch.id },
    group: 'launches',
    provider,
    phase: launch.phase,
    links: { streams: launch.streams, newsQuery: launch.mission?.name ?? launch.name, launchId: launch.id },
    render: { colorKey: 'vehicle', glyph: 'triangle', label: true },
    attrs: {
      provider: launch.provider ?? null,
      vehicle: launch.vehicle ?? null,
      orbit: launch.mission?.orbit ?? null,
      pad: launch.pad?.name ?? null,
      location: launch.pad?.location ?? null,
      status: launch.status.name,
      net: launch.net,
      hold: launch.hold,
      trajectory: trajectory?.id ?? null,
    },
  };
}

/** Re-derive every launch's phase from the FSM and refresh the `launch-*` entities. */
export function syncLaunchEntities(hub: Hub, nowMs = Date.now()): void {
  let phaseChanged = false;
  const launches = hub.launches.map((l) => {
    const state = deriveMissionState({ statusId: l.status.id, netMs: Date.parse(l.net), nowMs });
    if (state.phase === l.phase && state.hold === l.hold) return l;
    phaseChanged = true;
    return { ...l, phase: state.phase, hold: state.hold };
  });
  if (phaseChanged) hub.setLaunches(launches);
  hub.upsert(...(phaseChanged ? launches : hub.launches).map((l) => launchEntity(l, matchTrajectory(hub.trajectories, l))));
}

let phaseTimer: NodeJS.Timeout | undefined;

export const launchlibrary: Connector = {
  id: 'launchlibrary',
  intervalMs: POLL_MS,
  startDelayMs: 1000,
  start(ctx) {
    phaseTimer = setInterval(() => syncLaunchEntities(ctx.hub), PHASE_TICK_MS);
  },
  stop() {
    clearInterval(phaseTimer);
  },
  async run(ctx) {
    const { ll2Base, ll2Token } = ctx.config;
    const headers = ll2Token ? { authorization: `Token ${ll2Token}` } : undefined;
    const results = (text: string): Json[] => {
      const j = JSON.parse(text);
      if (!Array.isArray(j.results)) throw new Error(`unexpected LL2 response: ${text.slice(0, 120)}`);
      return j.results;
    };
    const [upcoming, previous] = await Promise.allSettled([
      ctx.cachedFetch('ll2:upcoming', `${ll2Base}/launch/upcoming/?limit=15&mode=detailed&ordering=net`, UPCOMING_TTL_MS, results, headers),
      ctx.cachedFetch('ll2:previous', `${ll2Base}/launch/previous/?limit=10&mode=detailed&ordering=-net`, PREVIOUS_TTL_MS, results, headers),
    ]);
    if (upcoming.status === 'rejected') throw upcoming.reason;
    const now = Date.now();
    const byId = new Map<string, Launch>();
    for (const raw of [...upcoming.value.value, ...(previous.status === 'fulfilled' ? previous.value.value : [])]) {
      if (raw?.id && raw.net) byId.set(raw.id, normalizeLaunch(raw, now));
    }
    ctx.hub.setLaunches([...byId.values()]);
    syncLaunchEntities(ctx.hub, now);
    ctx.health.note = previous.status === 'rejected' ? `previous launches unavailable: ${previous.reason.message}` : undefined;
    ctx.log(`${byId.size} launches`);
  },
};
