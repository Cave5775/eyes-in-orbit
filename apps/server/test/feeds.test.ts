import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { complexOfDish, parseDsn, probeAttrs } from '../src/connectors/dsn';
import { HORIZONS_FUTURE_DAYS, HORIZONS_PAST_DAYS, horizonsUrl, parseHorizonsVectors } from '../src/connectors/horizons';
import { decodeUpdate, issTimestampMs, telemetryPoint } from '../src/connectors/iss-live';
import { normalizeIssFix } from '../src/connectors/iss-rest';
import { newsUrl, normalizeArticle, parseArticles } from '../src/connectors/snapi';

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
