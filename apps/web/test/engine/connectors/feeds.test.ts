import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { complexOfDish, parseDsn, probeAttrs } from '../../../src/engine/connectors/dsn';
import { DEFAULT_HORIZONS, DSN_TARGETS, activeTargets, dsnCodes, horizonsSpecOf, probeEntity } from '../../../src/engine/connectors/dsn-targets';
import { decodeUpdate, issTimestampMs, telemetryPoint } from '../../../src/engine/connectors/iss-live';
import { normalizeIssFix } from '../../../src/engine/connectors/iss-rest';
import { newsUrl, normalizeArticle, parseArticles } from '../../../src/engine/connectors/snapi';

// ported from the server's feeds test (the Horizons cases arrive with that connector)
const fixture = (name: string) => readFileSync(new URL(`../../../../server/test/fixtures/${name}`, import.meta.url), 'utf8');

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

// the DSN target table as the Horizons connector reads it (the URL and cache-key cases arrive with that connector)
describe('dsn targets', () => {
  /** Mars orbiters: code -> [Horizons id, step in minutes] */
  const MARS_ORBITERS: Record<string, [string, number]> = { MRO: ['-74', 5], ODY: ['-53', 5], TGO: ['-143', 5], MEX: ['-41', 10] };

  it('leaves every default target geocentric with 30 min steps and a -3 d .. +7 d window', () => {
    for (const [code, target] of activeTargets()) {
      if (code === 'LRO' || code in MARS_ORBITERS) continue;
      expect(horizonsSpecOf(target), code).toEqual(DEFAULT_HORIZONS);
      expect(probeEntity(code), code).toMatchObject({ bodyId: 'EARTH' });
      // only the observatory attributes (JWST, TESS, Chandra); nothing about the track
      expect(Object.keys(probeEntity(code).attrs ?? {}).filter((k) => !k.startsWith('observatory')), code).toEqual([]);
    }
    expect(DEFAULT_HORIZONS).toEqual({ center: '500@399', frame: 'EARTH:inertial', bodyId: 'EARTH', stepMin: 30, pastDays: 3, futureDays: 7 });
  });

  it('fetches LRO Moon-centred with 5 min steps over -1 d .. +3 d', () => {
    expect(horizonsSpecOf(DSN_TARGETS.LRO)).toEqual({ center: '500@301', frame: 'MOON:inertial', bodyId: 'MOON', stepMin: 5, pastDays: 1, futureDays: 3 });
    expect(DSN_TARGETS.LRO.horizons).toBe('-85');
  });

  it('builds the LRO entity on the Moon with the Moon-centred note and keeps name, aliases, group and render hints', () => {
    expect(probeEntity('LRO')).toMatchObject({
      id: 'dsn-LRO', name: 'Lunar Reconnaissance Orbiter', kind: 'probe', bodyId: 'MOON', group: 'dsn',
      aliases: { dsn: 'LRO', horizons: '-85' }, render: { colorKey: 'probe', glyph: 'diamond', label: true },
      attrs: { trackCentre: 'Moon' },
    });
    expect(String(probeEntity('LRO').attrs?.trackNote)).toMatch(/Moon-centred/);
  });

  it('MAVEN has ended (declared over 2026-06-03): no Horizons request, no entity, no DSN attrs; the record stays in the table', () => {
    expect(DSN_TARGETS.MVN).toMatchObject({ horizons: '-202', ended: '2026-06-03' });
    expect(activeTargets().map(([c]) => c)).not.toContain('MVN');
    expect(dsnCodes()).not.toContain('MVN');
    expect(activeTargets().length).toBe(Object.keys(DSN_TARGETS).length - 1);
    // every other target is still scheduled
    for (const [code, t] of Object.entries(DSN_TARGETS)) if (code !== 'MVN') expect(t.ended, code).toBeUndefined();
  });

  it('fetches every Mars orbiter Mars-centred (500@499, MARS:inertial, bodyId MARS) with a step that resolves its orbit', () => {
    for (const [code, [id, step]] of Object.entries(MARS_ORBITERS)) {
      const t = DSN_TARGETS[code];
      expect(t.horizons, code).toBe(id);
      expect(horizonsSpecOf(t), code).toEqual({ center: '500@499', frame: 'MARS:inertial', bodyId: 'MARS', stepMin: step, pastDays: 1, futureDays: 3 });
      // the step resolves the orbit: well under a tenth of the 1.9 h to 6.7 h period
      expect(step, code).toBeLessThanOrEqual(10);
      expect(probeEntity(code), code).toMatchObject({ bodyId: 'MARS', group: 'dsn', kind: 'probe', attrs: { trackCentre: 'Mars' } });
      expect(String(probeEntity(code).attrs?.trackNote), code).toMatch(/Mars-centred/);
    }
  });

  it('leaves the cruising probes on the default Earth-centred query (the Mars rovers MSL and M20 are surface sites, not targets)', () => {
    expect(DSN_TARGETS.MSL).toBeUndefined();
    expect(DSN_TARGETS.M20).toBeUndefined();
    for (const code of ['VGR1', 'JWST', 'NHPC']) {
      expect(horizonsSpecOf(DSN_TARGETS[code]), code).toEqual(DEFAULT_HORIZONS);
      expect(probeEntity(code), code).toMatchObject({ bodyId: 'EARTH' });
    }
  });
});
