import { XMLParser } from 'fast-xml-parser';
import type { DsnLink, DsnSnapshot } from '@eio/core';
import type { Connector } from '../connector';
import type { NewEntity } from '../hub';
import { DSN_STATIONS, DSN_TARGETS, probeEntity, probeId } from './dsn-targets';

const POLL_MS = 5000;
/** probe attrs change with every range tick; republishing them at most this often keeps `entities.changed` quiet */
const ATTR_REFRESH_MS = 60_000;
const C_KM_S = 299_792.458;

type Json = Record<string, any>;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  isArray: (name) => ['dish', 'upSignal', 'downSignal', 'target'].includes(name),
});

/** DSS 10-29 Goldstone, 30-49 Canberra, 50-69 Madrid (DSS 1x-2x is California, 3x-4x Australia, 5x-6x Spain). */
export function complexOfDish(name: string): DsnLink['complex'] {
  const n = Number(/(\d+)/.exec(name)?.[1]);
  if (n >= 10 && n < 30) return 'Goldstone';
  if (n >= 30 && n < 50) return 'Canberra';
  if (n >= 50 && n < 70) return 'Madrid';
  return 'Unknown';
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' && v.trim() === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : undefined;
};
/** DSN uses -1 for "no value" */
const positive = (v: unknown): number | undefined => {
  const n = num(v);
  return n !== undefined && n > 0 ? n : undefined;
};

function signal(list: Json[] | undefined, powerInKw: boolean): DsnLink['downlink'] {
  if (!list?.length) return undefined;
  const s = list.find((x) => x.active === 'true') ?? list[0];
  return {
    active: s.active === 'true',
    band: s.band || undefined,
    frequencyHz: positive(s.frequency),
    dataRateBps: positive(s.dataRate),
    // uplink power is kW; downlink power is dBm in the feed and is not mapped
    powerKw: powerInKw ? positive(s.power) : undefined,
  };
}

/** Parse `dsn.xml` (dishes with up/down signals and targets) into links. Dish names are `DSS14` -> `DSS-14`. */
export function parseDsn(xml: string, nowMs = Date.now()): DsnSnapshot {
  const root = parser.parse(xml)?.dsn;
  if (!root) throw new Error(`not a DSN document: ${xml.slice(0, 80)}`);
  const links: DsnLink[] = [];
  for (const dish of (root.dish ?? []) as Json[]) {
    const dishId = String(dish.name).replace(/^DSS-?(\d+)$/i, 'DSS-$1');
    // target id 99 is DSN-internal (maintenance, calibration), not a spacecraft
    const targets = ((dish.target ?? []) as Json[]).filter((t) => String(t.id) !== '99');
    const ranged = targets.find((t) => positive(t.downlegRange) ?? positive(t.uplegRange));
    const up = positive(ranged?.uplegRange), down = positive(ranged?.downlegRange);
    // rtlt is often -1 while ranges are known: derive the light time from the two legs
    const rtlt = positive(ranged?.rtlt) ?? (up !== undefined && down !== undefined ? (up + down) / C_KM_S : undefined);
    links.push({
      dish: dishId,
      complex: complexOfDish(dishId),
      spacecraft: [...new Set(targets.map((t) => String(t.name)))],
      azimuthDeg: num(dish.azimuthAngle),
      elevationDeg: num(dish.elevationAngle),
      rangeKm: down ?? up,
      rtltSec: rtlt,
      downlink: signal(dish.downSignal, false),
      uplink: signal(dish.upSignal, true),
    });
  }
  return { fetchedAt: nowMs, links };
}

/** Attrs describing the current DSN contact of one spacecraft, or nulls when it is not tracked. */
export function probeAttrs(code: string, links: DsnLink[]): NonNullable<NewEntity['attrs']> {
  const mine = links.filter((l) => l.spacecraft.includes(code));
  const best = mine.find((l) => l.downlink?.active || l.uplink?.active) ?? mine[0];
  return {
    dish: mine.map((l) => l.dish).join(', ') || null,
    rangeKm: best?.rangeKm ?? null,
    rtltSec: best?.rtltSec ?? null,
    dataRateBps: best?.downlink?.dataRateBps ?? null,
    band: best?.downlink?.band ?? null,
    downlinkActive: best ? !!best.downlink?.active : false,
  };
}

let workingUrl: string | undefined;
const lastAttrUpdate = new Map<string, number>();

export const dsn: Connector = {
  id: 'dsn',
  intervalMs: POLL_MS,
  startDelayMs: 500,
  start(ctx) {
    ctx.hub.upsert(
      ...DSN_STATIONS.map((s): NewEntity => ({
        id: s.id, name: s.name, kind: 'ground_station', bodyId: 'EARTH', aliases: { dsn: s.complex }, group: 'dsn',
        provider: { type: 'geodetic', bodyId: 'EARTH', latDeg: s.latDeg, lonDeg: s.lonDeg, altKm: s.altKm },
        render: { colorKey: 'ground', glyph: 'square', label: true },
      })),
      ...Object.keys(DSN_TARGETS).map(probeEntity),
    );
  },
  async run(ctx) {
    const candidates = workingUrl ? [workingUrl, ...ctx.config.dsnUrls.filter((u) => u !== workingUrl)] : ctx.config.dsnUrls;
    const errors: string[] = [];
    let snapshot: DsnSnapshot | undefined;
    for (const url of candidates) {
      try {
        // the feed is behind a CDN; the query string defeats stale copies
        snapshot = parseDsn(await ctx.http.text(`${url}${url.includes('?') ? '&' : '?'}r=${Date.now()}`));
        workingUrl = url;
        break;
      } catch (err) {
        errors.push(`${url}: ${(err as Error).message}`);
      }
    }
    if (!snapshot) throw new Error(errors.join(' | '));
    ctx.hub.setDsn(snapshot);
    ctx.health.note = `${snapshot.links.length} dishes via ${workingUrl}`;

    const now = Date.now();
    for (const code of Object.keys(DSN_TARGETS)) {
      const prev = ctx.hub.graph.get(probeId(code));
      const attrs = probeAttrs(code, snapshot.links);
      const wasTracked = prev?.attrs?.dish != null, tracked = attrs.dish != null;
      const recent = now - (lastAttrUpdate.get(code) ?? 0) < ATTR_REFRESH_MS;
      if (!prev || (!tracked && !wasTracked) || (recent && tracked === wasTracked)) continue;
      lastAttrUpdate.set(code, now);
      ctx.hub.upsert({ ...prev, attrs: { ...prev.attrs, ...attrs } });
    }
  },
};
