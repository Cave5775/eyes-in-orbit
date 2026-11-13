import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EntityGraph, bodyEntityRecords, convert, norm } from '@eio/core';
import { complexOfDish, parseDsn, probeAttrs } from '../src/connectors/dsn';
import { DEFAULT_HORIZONS, DSN_TARGETS, horizonsSpecOf, probeEntity } from '../src/connectors/dsn-targets';
import { HORIZONS_FUTURE_DAYS, HORIZONS_PAST_DAYS, horizonsCacheKey, horizonsUrl, parseHorizonsVectors } from '../src/connectors/horizons';
import { decodeUpdate, issTimestampMs, telemetryPoint } from '../src/connectors/iss-live';
import { normalizeIssFix } from '../src/connectors/iss-rest';
import { newsUrl, normalizeArticle, parseArticles } from '../src/connectors/snapi';

/** Mars orbiters: code -> [Horizons id, step in minutes] */
const MARS_ORBITERS: Record<string, [string, number]> = { MRO: ['-74', 5], ODY: ['-53', 5], MVN: ['-202', 10], TGO: ['-143', 5], MEX: ['-41', 10] };

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

describe('snapi normalize', () => {
  it('maps a v4 page', () => {
    const articles = parseArticles(fixture('snapi-articles.json'));
    expect(articles).toHaveLength(2);
    expect(articles[0]).toMatchObject({
      id: 40530, site: 'European Spaceflight', publishedAt: '2026-10-22T15:02:37Z',
      title: 'ESA Provides New Details on Failed Space Rider Drop Test',
    });
    expect(articles[0].imageUrl).toMatch(/^https:\/\/europeanspaceflight\.com/);
    expect(articles[0].launchIds).toBeUndefined();
  });

  it('collects launch ids and drops empty fields', () => {
    const a = normalizeArticle({ id: 1, title: 't', url: 'u', news_site: 's', summary: '', image_url: '', published_at: 'p', launches: [{ launch_id: 'abc', provider: 'LL2' }] });
    expect(a).toMatchObject({ launchIds: ['abc'], summary: undefined, imageUrl: undefined });
  });

  it('rejects malformed pages and builds search urls', () => {
    expect(() => parseArticles('{"detail":"Not found."}')).toThrow(/unexpected SNAPI/);
    expect(newsUrl({ search: 'iss crew', limit: 5 })).toBe('https://api.spaceflightnewsapi.net/v4/articles/?limit=5&ordering=-published_at&search=iss+crew');
  });
});

describe('dsn parse', () => {
  it('infers the complex from the DSS number', () => {
    expect(complexOfDish('DSS-14')).toBe('Goldstone');
    expect(complexOfDish('DSS26')).toBe('Goldstone');
    expect(complexOfDish('DSS-34')).toBe('Canberra');
    expect(complexOfDish('DSS-43')).toBe('Canberra');
    expect(complexOfDish('DSS-54')).toBe('Madrid');
    expect(complexOfDish('DSS-65')).toBe('Madrid');
    expect(complexOfDish('DSS-5')).toBe('Unknown');
  });

  const snap = () => parseDsn(fixture('dsn.xml'), 123);
  const dish = (name: string) => snap().links.find((l) => l.dish === name)!;

  it('turns dishes into links', () => {
    const s = snap();
    expect(s.fetchedAt).toBe(123);
    expect(s.links.map((l) => `${l.dish}:${l.complex}`)).toEqual([
      'DSS-14:Goldstone', 'DSS-25:Goldstone', 'DSS-43:Canberra', 'DSS-56:Madrid', 'DSS-63:Madrid',
    ]);
    expect(dish('DSS-14').spacecraft).toEqual([]); // target 99 is not a spacecraft
    expect(dish('DSS-63').spacecraft).toEqual(['JWST']);
  });

  it('reads ranges, light time and signals; derives rtlt when the feed says -1', () => {
    expect(dish('DSS-43')).toMatchObject({
      spacecraft: ['VGR2'], azimuthDeg: 17, elevationDeg: 88, rangeKm: 2.1086e10, rtltSec: 140480.3,
      downlink: { active: true, band: 'X', frequencyHz: 8.4e9, dataRateBps: 160 },
      uplink: { active: true, band: 'S', powerKw: 20.2, dataRateBps: 16 },
    });
    const lro = dish('DSS-56');
    expect(lro.rangeKm).toBe(382000);
    expect(lro.rtltSec).toBeCloseTo(764000 / 299792.458, 6);
    expect(lro.downlink!.active).toBe(false);
    expect(dish('DSS-25').rangeKm).toBeUndefined();
  });

  it('summarises a spacecraft contact for its entity attrs', () => {
    const links = snap().links;
    expect(probeAttrs('VGR2', links)).toMatchObject({ dish: 'DSS-43', rangeKm: 2.1086e10, dataRateBps: 160, band: 'X', downlinkActive: true });
    expect(probeAttrs('M20', links)).toMatchObject({ dish: null, rangeKm: null, downlinkActive: false });
  });

  it('rejects non-DSN documents', () => {
    expect(() => parseDsn('<html><body>moved</body></html>')).toThrow(/not a DSN document/);
  });
});

describe('horizons', () => {
  it('builds a geocentric ICRF vectors query', () => {
    const url = new URL(horizonsUrl('-31', Date.parse('2026-10-22T14:05:00Z')));
    const p = url.searchParams;
    expect(p.get('COMMAND')).toBe("'-31'");
    expect(p.get('CENTER')).toBe("'500@399'");
    expect(p.get('EPHEM_TYPE')).toBe('VECTORS');
    expect(p.get('REF_PLANE')).toBe('FRAME');
    expect(p.get('OUT_UNITS')).toBe('KM-S');
    expect(p.get('STEP_SIZE')).toBe("'30 m'");
    expect(p.get('CSV_FORMAT')).toBe('YES');
    expect(p.get('START_TIME')).toBe("'2026-10-19 14:00'");
    expect(p.get('STOP_TIME')).toBe("'2026-10-29 14:00'");
  });

  it('covers -3 d to +7 d around the fetch hour in a few hundred rows', () => {
    const now = Date.parse('2026-10-22T14:05:00Z');
    const p = new URL(horizonsUrl('-31', now)).searchParams;
    const parse = (s: string | null) => Date.parse(`${s!.replace(/'/g, '').replace(' ', 'T')}:00Z`);
    const start = parse(p.get('START_TIME')), stop = parse(p.get('STOP_TIME'));
    expect(now - start).toBeGreaterThanOrEqual(HORIZONS_PAST_DAYS * 86_400_000);
    expect(stop - now).toBeGreaterThanOrEqual(HORIZONS_FUTURE_DAYS * 86_400_000 - 3_600_000);
    expect((stop - start) / 1_800_000 + 1).toBe(481);
  });

  const NOW = Date.parse('2026-10-22T14:05:00Z');

  it('leaves every default target geocentric with 30 min steps and a -3 d .. +7 d window', () => {
    const plain = horizonsUrl('-31', NOW);
    for (const [code, target] of Object.entries(DSN_TARGETS)) {
      if (code === 'LRO' || code in MARS_ORBITERS) continue;
      const spec = horizonsSpecOf(target);
      expect(spec, code).toEqual(DEFAULT_HORIZONS);
      expect(horizonsUrl('-31', NOW, spec), code).toBe(plain);
      expect(probeEntity(code), code).toMatchObject({ bodyId: 'EARTH' });
      // only the observatory attributes (JWST, TESS, Chandra); nothing about the track
      expect(Object.keys(probeEntity(code).attrs ?? {}).filter((k) => !k.startsWith('observatory')), code).toEqual([]);
    }
    expect(DEFAULT_HORIZONS).toEqual({ center: '500@399', frame: 'EARTH:inertial', bodyId: 'EARTH', stepMin: 30, pastDays: 3, futureDays: 7 });
  });

  it('fetches LRO Moon-centred with 5 min steps over -1 d .. +3 d', () => {
    const spec = horizonsSpecOf(DSN_TARGETS.LRO);
    expect(spec).toEqual({ center: '500@301', frame: 'MOON:inertial', bodyId: 'MOON', stepMin: 5, pastDays: 1, futureDays: 3 });
    const p = new URL(horizonsUrl(DSN_TARGETS.LRO.horizons, NOW, spec)).searchParams;
    expect(p.get('COMMAND')).toBe("'-85'");
    expect(p.get('CENTER')).toBe("'500@301'");
    expect(p.get('STEP_SIZE')).toBe("'5 m'");
    expect(p.get('REF_PLANE')).toBe('FRAME');
    expect(p.get('START_TIME')).toBe("'2026-10-21 14:00'");
    expect(p.get('STOP_TIME')).toBe("'2026-10-25 14:00'");
    const parse = (s: string | null) => Date.parse(`${s!.replace(/'/g, '').replace(' ', 'T')}:00Z`);
    expect((parse(p.get('STOP_TIME')) - parse(p.get('START_TIME'))) / 300_000 + 1).toBe(1153);
  });

  it('builds the LRO entity on the Moon with the Moon-centred note and keeps name, aliases, group and render hints', () => {
    expect(probeEntity('LRO')).toMatchObject({
      id: 'dsn-LRO', name: 'Lunar Reconnaissance Orbiter', kind: 'probe', bodyId: 'MOON', group: 'dsn',
      aliases: { dsn: 'LRO', horizons: '-85' }, render: { colorKey: 'probe', glyph: 'diamond', label: true },
      attrs: { trackCentre: 'Moon' },
    });
    expect(String(probeEntity('LRO').attrs?.trackNote)).toMatch(/Moon-centred/);
  });

  it('fetches every Mars orbiter Mars-centred (500@499, MARS:inertial, bodyId MARS) with a step that resolves its orbit', () => {
    for (const [code, [id, step]] of Object.entries(MARS_ORBITERS)) {
      const t = DSN_TARGETS[code];
      expect(t.horizons, code).toBe(id);
      const spec = horizonsSpecOf(t);
      expect(spec, code).toEqual({ center: '500@499', frame: 'MARS:inertial', bodyId: 'MARS', stepMin: step, pastDays: 1, futureDays: 3 });
      const p = new URL(horizonsUrl(id, NOW, spec)).searchParams;
      expect(p.get('COMMAND'), code).toBe(`'${id}'`);
      expect(p.get('CENTER'), code).toBe("'500@499'");
      expect(p.get('STEP_SIZE'), code).toBe(`'${step} m'`);
      expect(p.get('EPHEM_TYPE'), code).toBe('VECTORS');
      expect(p.get('REF_PLANE'), code).toBe('FRAME');
      expect(p.get('START_TIME'), code).toBe("'2026-10-21 14:00'");
      expect(p.get('STOP_TIME'), code).toBe("'2026-10-25 14:00'");
      const parse = (s: string | null) => Date.parse(`${s!.replace(/'/g, '').replace(' ', 'T')}:00Z`);
      const rows = (parse(p.get('STOP_TIME')) - parse(p.get('START_TIME'))) / (step * 60_000) + 1;
      expect(rows, code).toBe(step === 5 ? 1153 : 577); // modest per-entity size
      // the step resolves the orbit: well under a tenth of the 1.9 h to 6.7 h period
      expect(step, code).toBeLessThanOrEqual(10);
      expect(probeEntity(code), code).toMatchObject({ bodyId: 'MARS', group: 'dsn', kind: 'probe', attrs: { trackCentre: 'Mars' } });
      expect(String(probeEntity(code).attrs?.trackNote), code).toMatch(/Mars-centred/);
      expect(horizonsCacheKey(id, spec), code).toBe(`horizons:v2:${id}:500@499:${step}m:-1d+3d`);
    }
  });

  it('leaves landers, rovers and the cruising probes on the default Earth-centred query', () => {
    for (const code of ['MSL', 'M20', 'VGR1', 'JWST', 'NHPC']) {
      expect(horizonsSpecOf(DSN_TARGETS[code]), code).toEqual(DEFAULT_HORIZONS);
      expect(probeEntity(code), code).toMatchObject({ bodyId: 'EARTH' });
    }
  });

  it('reads a recorded Mars-centred MRO response (Horizons 500@499, 5 min): ~3.7e3 km from Mars, a ~110 min orbit', () => {
    const samples = parseHorizonsVectors(fixture('horizons-mro-mars-centred.json'));
    expect(samples).toHaveLength(25);
    expect(samples[1][0] - samples[0][0]).toBeCloseTo(300_000, -2);
    for (const s of samples) {
      const r = Math.hypot(s[1], s[2], s[3]);
      expect(r).toBeGreaterThan(3600); // 3396 km Mars radius + 250 .. 320 km altitude
      expect(r).toBeLessThan(3700);
      expect(Math.hypot(s[4], s[5], s[6])).toBeGreaterThan(3.2); // orbital speed ~3.4 km/s
      expect(Math.hypot(s[4], s[5], s[6])).toBeLessThan(3.5);
    }
    // back near the first state after one period (~112 min = 22.4 rows)
    const d = (i: number, j: number) => Math.hypot(samples[i][1] - samples[j][1], samples[i][2] - samples[j][2], samples[i][3] - samples[j][3]);
    expect(d(0, 22)).toBeLessThan(d(0, 11)); // 110 min later is closer to the start than half an orbit later (7,000 km)
    expect(d(0, 11)).toBeGreaterThan(6000);
  });

  it('the fetched MRO entity sits on the displayed Mars: orbit radius from it at times across the window', () => {
    const t = DSN_TARGETS.MRO;
    const spec = horizonsSpecOf(t);
    const samples = parseHorizonsVectors(fixture('horizons-mro-mars-centred.json'));
    const g = new EntityGraph();
    for (const b of bodyEntityRecords()) g.upsert(b);
    g.upsert({ ...probeEntity('MRO'), updatedAt: 0, provider: { type: 'sampled', frame: spec.frame, samples } });
    expect(g.get('dsn-MRO')!.bodyId).toBe('MARS');
    for (const k of [0, 3, 7, 12, 18, 23]) {
      const tm = samples[k][0] + 100_000; // between rows, so the Hermite path is used
      const mars = convert({ frame: 'MARS:inertial', r: [0, 0, 0] }, 'EARTH:inertial', tm).r;
      const s = g.stateIn('dsn-MRO', tm, 'EARTH:inertial')!;
      const d = norm([s.r[0] - mars[0], s.r[1] - mars[1], s.r[2] - mars[2]]);
      expect(d, `row ${k}`).toBeGreaterThan(3600);
      expect(d, `row ${k}`).toBeLessThan(3700);
      expect(norm(s.r), `row ${k}`).toBeGreaterThan(5e7); // Earth-centred it is millions of km away, Mars-relative it is thousands
    }
  });

  it('keys the cache by target, centre, step and window, and not like the old geocentric key', () => {
    const lro = horizonsSpecOf(DSN_TARGETS.LRO);
    const key = horizonsCacheKey('-85', lro);
    expect(key).toContain('-85');
    expect(key).toContain('500@301');
    expect(key).toContain('5m');
    expect(key).toContain('-1d+3d');
    expect(key).not.toBe('horizons:w3-7:-85');
    expect(key).not.toBe(horizonsCacheKey('-85'));
    expect(horizonsCacheKey('-85', { ...lro, stepMin: 10 })).not.toBe(key);
    expect(horizonsCacheKey('-85', { ...lro, futureDays: 7 })).not.toBe(key);
    expect(horizonsCacheKey('-31')).toBe('horizons:v2:-31:500@399:30m:-3d+7d');
  });

  it('parses the $$SOE table into [tMs, r, v] samples (TDB -> UTC)', () => {
    const samples = parseHorizonsVectors(fixture('horizons-vectors.json'));
    expect(samples).toHaveLength(3);
    expect(samples[0]).toHaveLength(7);
    // JD 2461335.5 TDB = 2026-10-22T00:00:00 TDB = 00:00:00 - 69.184 s UTC
    expect(samples[0][0]).toBe(Date.parse('2026-10-22T00:00:00Z') - 69_184);
    expect(samples[1][0] - samples[0][0]).toBeCloseTo(1_800_000, -2);
    expect(samples[0].slice(1)).toEqual([-6.5e9, -2.6e10, 1.5e10, -12, -15, 10]);
  });

  it('reports targets without ephemeris', () => {
    expect(() => parseHorizonsVectors(fixture('horizons-noephem.json'))).toThrow(/No ephemeris for target/);
  });
});

describe('iss feeds', () => {
  it('normalizes the wheretheiss.at payload', () => {
    const fix = normalizeIssFix({
      name: 'iss', id: 25544, latitude: 49.07, longitude: -155.47, altitude: 429.6, velocity: 27566.6,
      visibility: 'daylight', footprint: 4556.01, timestamp: 1792691508, units: 'kilometers',
    });
    expect(fix).toEqual({ t: 1792691508000, latitude: 49.07, longitude: -155.47, altitudeKm: 429.6, velocityKmh: 27566.6, visibility: 'daylight', footprintKm: 4556.01 });
    expect(() => normalizeIssFix({ error: 'rate limited' })).toThrow(/unexpected/);
  });

  it('decodes Lightstreamer delta updates', () => {
    expect(decodeUpdate([null, null], '7098.5|42.25')).toEqual(['7098.5', '42.25']);
    expect(decodeUpdate(['1', '2', '3'], '|9|')).toEqual(['1', '9', '3']);
    expect(decodeUpdate(['1', '2', '3'], '^2|x')).toEqual(['1', '2', 'x']);
    expect(decodeUpdate(['1', '2'], '#|$')).toEqual([null, '']);
    expect(decodeUpdate([null], 'a%20b')).toEqual(['a b']);
  });

  it('maps ISSLIVE timestamps (hours since Dec 31 00:00 UTC) and items to telemetry points', () => {
    const now = Date.parse('2026-10-22T18:00:30Z');
    expect(issTimestampMs(7098.0, now)).toBe(Date.parse('2026-10-22T18:00:00Z'));
    const p = telemetryPoint('S0000003', ['7098', '317.43'], now)!;
    expect(p).toMatchObject({ id: 'S0000003', value: '317.43', unit: 'deg', t: Date.parse('2026-10-22T18:00:00Z') });
    expect(telemetryPoint('NOPE', ['1', '2'], now)).toBeUndefined();
    expect(telemetryPoint('S0000003', ['7098', null], now)).toBeUndefined();
  });
});
