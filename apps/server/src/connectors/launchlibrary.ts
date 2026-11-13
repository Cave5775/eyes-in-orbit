import {
  ascentEntityEvents, boosterLandingPoint, deriveMissionState, missionTimingFor, modeledBoosterSegments, orbitSegmentsOf, type Launch, type LiveAscent,
  type StreamLink,
} from '@eio/core';
import type { Connector } from '../connector';
import type { Hub, NewEntity } from '../hub';
import { planAscent } from '../telemetry';
import { matchTrajectory, type Trajectory } from '../trajectory';

const POLL_MS = 10 * 60_000;
const PHASE_TICK_MS = 15_000;
const UPCOMING_TTL_MS = 9 * 60_000;
/** past launches change rarely; a longer TTL keeps the anonymous tier (15 req/h; capped at 7 by `net/limits.ts`) comfortable */
const PREVIOUS_TTL_MS = 55 * 60_000;
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

/** LL2 2.2.0 returned `vidURLs` (and an empty `vid_urls` next to it); 2.3.0 fills `vid_urls`. Accept either. Official webcasts first. */
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

/** First-stage recovery plan from `rocket.launcher_stage[0].landing` (detailed mode), if present. */
function normalizeLanding(raw: Json): Launch['landing'] {
  const l = raw.rocket?.launcher_stage?.[0]?.landing;
  if (!l || typeof l.attempt !== 'boolean') return undefined;
  // 2.3.0 calls the landing place `landing_location` (2.2.0: `location`)
  return { attempt: l.attempt, location: l.landing_location?.abbrev ?? l.location?.abbrev ?? undefined, type: l.type?.abbrev ?? undefined };
}

export function normalizeLaunch(raw: Json, nowMs = Date.now()): Launch {
  const status = raw.status ?? {};
  const orbit = raw.mission?.orbit;
  const lat = num(raw.pad?.latitude), lon = num(raw.pad?.longitude);
  const vehicle = raw.rocket?.configuration?.full_name ?? raw.rocket?.configuration?.name;
  const state = deriveMissionState({ statusId: status.id, netMs: Date.parse(raw.net), nowMs, ...missionTimingFor({ vehicle, name: raw.name }) });
  return {
    id: raw.id,
    name: raw.name,
    status: { id: status.id, name: status.name, abbrev: status.abbrev },
    net: raw.net,
    windowStart: raw.window_start ?? undefined,
    windowEnd: raw.window_end ?? undefined,
    provider: raw.launch_service_provider?.name,
    vehicle,
    mission: raw.mission ? {
      name: raw.mission.name, type: raw.mission.type ?? undefined, description: raw.mission.description ?? undefined,
      orbit: orbit?.abbrev ?? orbit?.name ?? undefined,
    } : undefined,
    pad: lat !== undefined && lon !== undefined
      ? { name: raw.pad.name, latitude: lat, longitude: lon, location: raw.pad.location?.name, countryCode: raw.pad.location?.country_code ?? raw.pad.country?.alpha_3_code ?? raw.pad.location?.country?.alpha_3_code }
      : undefined,
    streams: normalizeStreams(raw, nowMs),
    image: typeof raw.image === 'string' ? raw.image : raw.image?.image_url ?? undefined,
    landing: normalizeLanding(raw),
    phase: state.phase,
    hold: state.hold,
    entityId: `launch-${raw.id}`,
  };
}

/**
 * `launch-<id>` entity. Provider: geodetic at the pad, or a pad -> ascent composite from (in order)
 * measured telemetry (`live`), a trajectory file, or the nominal Falcon 9 model (see `telemetry.ts`).
 * `attrs.trajectorySource` says which: `live`, `file` or `modeled` (null: pad only).
 */
export function launchEntity(launch: Launch, trajectory?: Trajectory, live?: LiveAscent): NewEntity {
  const pad = launch.pad;
  let provider: NewEntity['provider'];
  const plan = planAscent(launch, trajectory, live);
  if (pad) {
    provider = plan.segments
      ? { type: 'composite', segments: plan.segments }
      : { type: 'geodetic', bodyId: 'EARTH', latDeg: pad.latitude, lonDeg: pad.longitude, altKm: 0 };
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
    events: plan.events,
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
      trajectorySource: plan.source,
      trajectoryNote: plan.source === 'modeled' ? 'MODELED nominal ascent, not measured' : plan.source === 'live' ? 'measured rows posted to /api/telemetry' : null,
      ascentInclinationDeg: plan.source === 'modeled' ? plan.modeled?.inclinationDeg ?? null : null,
      ascentAzimuthDeg: plan.azimuthDeg ?? null,
      liveRows: live?.rows.length ?? null,
      liveLastTSec: live?.rows.length ? live.rows[live.rows.length - 1].tSec : null,
      liveExtrapolatedFromSec: plan.extrapolatedFromSec,
    },
  };
}

/**
 * `launch-<id>-booster`: the first stage as its own entity (pad, ascent to stage separation, then the modeled return and
 * landing). Only for recovered Falcon 9 boosters with a modeled ascent; a trajectory file replaces the vehicle path and
 * with it the separation state the return is built from, so there is no booster entity then.
 */
export function boosterEntity(launch: Launch, trajectory?: Trajectory, live?: LiveAscent): NewEntity | null {
  const plan = planAscent(launch, trajectory, live);
  const m = plan.modeled;
  const netMs = Date.parse(launch.net);
  if (!launch.pad || !m?.booster || plan.source === 'file' || !Number.isFinite(netMs)) return null;
  const pad = { latDeg: launch.pad.latitude, lonDeg: launch.pad.longitude };
  const segments = modeledBoosterSegments(netMs, pad, m);
  const land = boosterLandingPoint(pad, m);
  if (!segments || !land) return null;
  return {
    id: `${launch.entityId}-booster`,
    name: `${launch.name} (booster)`,
    kind: 'stage',
    bodyId: 'EARTH',
    parentId: launch.entityId,
    aliases: {},
    group: 'launches',
    provider: { type: 'composite', segments },
    events: ascentEntityEvents(m.events.filter((e) => e.track === 'booster'), netMs),
    render: { colorKey: 'vehicle', glyph: 'triangle', trailSeconds: 120, label: true, model: 'rocket-stage' },
    attrs: {
      provider: launch.provider ?? null,
      launch: launch.name,
      recovery: m.recovery,
      landingSite: launch.landing?.location ?? null,
      landingDownrangeKm: Math.round(m.booster.landingDownrangeKm),
      landingLatDeg: Math.round(land.latDeg * 1e4) / 1e4,
      landingLonDeg: Math.round(land.lonDeg * 1e4) / 1e4,
      trajectorySource: 'modeled',
      trajectoryNote: 'MODELED booster return path through the event times, not measured',
    },
  };
}

/**
 * `launch-<id>-payload`: the object the launch put in orbit, as a satellite that follows the same modeled two-body orbit as the
 * launch vehicle after the end of the modeled ascent (`on orbit (modeled)`, about 12 h, no J2). A PLACEHOLDER until the payload
 * appears in a TLE feed, so it is only worth having for the launches LL2 still lists as previous (the 10 newest). Only for
 * launches that are flying or flown and not failed (`phase` ACTIVE_ASCENT, ORBIT_INSERTION or ON_ORBIT) whose ascent reaches
 * orbit; it has no position before the end of the modeled ascent and none after the 12 hours.
 */
export function payloadEntity(launch: Launch, trajectory?: Trajectory, live?: LiveAscent): NewEntity | null {
  if (!launch.pad || !['ACTIVE_ASCENT', 'ORBIT_INSERTION', 'ON_ORBIT'].includes(launch.phase)) return null;
  const plan = planAscent(launch, trajectory, live);
  // the orbit continuation of the vehicle path, without its pad tail: the payload does not return to the pad
  const segments = orbitSegmentsOf(plan.segments);
  if (!segments) return null;
  return {
    id: `${launch.entityId}-payload`,
    name: `${launch.mission?.name ?? launch.name} (payload)`,
    kind: 'satellite',
    bodyId: 'EARTH',
    parentId: launch.entityId,
    aliases: {},
    group: 'launches',
    provider: { type: 'composite', segments },
    render: { colorKey: 'satellite', label: true, orbitLine: true },
    attrs: {
      provider: launch.provider ?? null,
      launch: launch.name,
      mission: launch.mission?.name ?? null,
      orbit: launch.mission?.orbit ?? null,
      ascentInclinationDeg: plan.modeled?.inclinationDeg ?? null,
      trajectorySource: 'modeled',
      trajectoryNote: 'MODELED two-body orbit (no J2, no drag) from the end of the modeled ascent, about 12 h, until a TLE exists',
    },
  };
}

/** Re-derive every launch's phase from the FSM and refresh the `launch-*` entities. */
export function syncLaunchEntities(hub: Hub, nowMs = Date.now()): void {
  let phaseChanged = false;
  const launches = hub.launches.map((l) => {
    const state = deriveMissionState({ statusId: l.status.id, netMs: Date.parse(l.net), nowMs, ...missionTimingFor(l) });
    if (state.phase === l.phase && state.hold === l.hold) return l;
    phaseChanged = true;
    return { ...l, phase: state.phase, hold: state.hold };
  });
  if (phaseChanged) hub.setLaunches(launches);
  hub.upsert(...(phaseChanged ? launches : hub.launches).flatMap((l) => {
    const trajectory = matchTrajectory(hub.trajectories, l), live = hub.liveTelemetry.get(l.id);
    return [launchEntity(l, trajectory, live), boosterEntity(l, trajectory, live), payloadEntity(l, trajectory, live)].filter((e): e is NewEntity => e !== null);
  }));
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
    // a run that fell back to a stale copy is retried at the normal interval (it was every 5 min: up to 24 requests per hour against a limit of 15)
    const ro = { source: 'll2', mode: 'poll', staleRetryMs: POLL_MS } as const;
    const results = (text: string): Json[] => {
      const j = JSON.parse(text);
      if (!Array.isArray(j.results)) throw new Error(`unexpected LL2 response: ${text.slice(0, 120)}`);
      return j.results;
    };
    const [upcoming, previous] = await Promise.allSettled([
      ctx.cachedFetch('ll2:upcoming', `${ll2Base}/launches/upcoming/?limit=15&mode=detailed&ordering=net`, UPCOMING_TTL_MS, results, headers, ro),
      ctx.cachedFetch('ll2:previous', `${ll2Base}/launches/previous/?limit=10&mode=detailed&ordering=-net`, PREVIOUS_TTL_MS, results, headers, ro),
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
