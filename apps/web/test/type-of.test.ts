import { describe, expect, it } from 'vitest';
import type { EntityRecord, Sample } from '@eio/core';
import { categoryCounts, categoryOf, matchesType } from '../src/lib/browser-ui';
import { facetCounts, rankEntities, searchHitOf } from '../src/lib/filters';
import { textHitsOf } from '../src/lib/text-match';
import { NO_FOCUS, classify, isDrawn, termFromWord, type Query } from '../src/lib/query';
import { typeOf, viewClass } from '../src/lib/view-class';
import { mockGroundAndProbes } from '../src/mock/generators';
import { activeTargets, probeEntity } from '../src/engine/connectors/dsn-targets';

const T = Date.UTC(2026, 9, 22);
const sampled = (frame: string, r: number): EntityRecord['provider'] => ({
  type: 'sampled', frame: frame as `${string}:inertial`, samples: [[T, r, 0, 0], [T + 3_600_000, r, 0, 0]] as Sample[],
});
const rec = (id: string, kind: string, bodyId: string, provider?: EntityRecord['provider']): EntityRecord => ({
  id, name: id, kind, bodyId, aliases: {}, provider, updatedAt: 0,
});

describe('typeOf: the type shown and queried comes from the same rule as the category', () => {
  it('a probe that orbits another body is a satellite', () => {
    expect(typeOf(rec('a', 'probe', 'MARS', sampled('MARS:inertial', 3800)))).toBe('satellite');
    expect(typeOf(rec('a', 'probe', 'MOON', sampled('MOON:inertial', 1840)))).toBe('satellite');
  });

  it('is detected from the track, not from the name or the feed centre (Juno round Jupiter, fetched Earth-centred)', () => {
    // feed centre Earth, but the samples are expressed round Jupiter and stay inside its sphere of influence
    const juno = rec('dsn-JNO', 'probe', 'EARTH', sampled('JUPITER:inertial', 1.2e6));
    expect(viewClass(juno)).toBe('orbiter');
    expect(typeOf(juno)).toBe('satellite');
    expect(categoryOf(juno)).toBe('satellites');
    // an unknown spacecraft with an unknown name round Mars is detected the same way
    expect(typeOf(rec('dsn-NEW', 'probe', 'EARTH', sampled('MARS:inertial', 9000)))).toBe('satellite');
  });

  it('keeps the stored kind for everything else', () => {
    expect(typeOf(rec('v', 'probe', 'EARTH', sampled('EARTH:inertial', 2.5e10)))).toBe('probe');
    expect(typeOf(rec('v', 'probe', 'SUN'))).toBe('probe');
    expect(typeOf(rec('j', 'probe', 'EARTH', sampled('EARTH:inertial', 1.5e6)))).toBe('probe'); // JWST at L2
    expect(typeOf(rec('r', 'rover', 'MARS', { type: 'geodetic', bodyId: 'MARS', latDeg: 0, lonDeg: 0, altKm: 0 }))).toBe('rover');
    expect(typeOf(rec('l', 'lander', 'MARS'))).toBe('lander');
    expect(typeOf(rec('s', 'station', 'MARS', sampled('MARS:inertial', 3800)))).toBe('station');
    expect(typeOf(rec('g', 'ground_station', 'EARTH'))).toBe('ground_station');
    expect(typeOf(rec('s', 'satellite', 'EARTH'))).toBe('satellite');
  });

  it('every DSN target of the server: the type is a satellite exactly when the category is satellites', () => {
    const sat: string[] = [];
    for (const [code] of activeTargets()) {
      const e = probeEntity(code) as EntityRecord;
      expect(e.kind, code).toBe('probe'); // the stored kind does not change
      expect(typeOf(e) === 'satellite', code).toBe(categoryOf(e) === 'satellites');
      if (typeOf(e) === 'satellite') sat.push(code);
    }
    expect(sat.sort()).toEqual(['LRO', 'MEX', 'MRO', 'ODY', 'TGO']);
  });

  it('the mock catalogue agrees', () => {
    const all = Object.fromEntries(mockGroundAndProbes(Date.UTC(2026, 5, 1)).map((e) => [e.id, e]));
    expect(typeOf(all['dsn-MRO'])).toBe('satellite');
    expect(typeOf(all['dsn-LRO'])).toBe('satellite');
    expect(typeOf(all['dsn-VGR1'])).toBe('probe');
    expect(typeOf(all['dsn-JWST'])).toBe('probe');
  });
});

describe('the type is what every surface uses', () => {
  const mro = rec('dsn-MRO', 'probe', 'MARS', sampled('MARS:inertial', 3800));
  const vgr = rec('dsn-VGR1', 'probe', 'EARTH', sampled('EARTH:inertial', 2.5e10));

  it('type:satellite lists the orbiter, type:probe does not; type:satellites is the category', () => {
    expect(matchesType(mro, 'satellite')).toBe(true);
    expect(matchesType(mro, 'probe')).toBe(false);
    expect(matchesType(mro, 'probes')).toBe(false);
    expect(matchesType(mro, 'satellites')).toBe(true);
    expect(matchesType(vgr, 'probe')).toBe(true);
    expect(matchesType(vgr, 'satellite')).toBe(false);
  });

  it('a search hit without position data keeps the stored kind', () => {
    expect(matchesType({ kind: 'probe' }, 'probe')).toBe(true);
    expect(matchesType({ kind: 'probe', bodyId: 'MARS' }, 'satellite')).toBe(true);
  });

  it('list rows and search hits carry the type', () => {
    expect(searchHitOf(mro).kind).toBe('satellite');
    expect(searchHitOf(vgr).kind).toBe('probe');
    expect(rankEntities([mro, vgr], 'dsn-MRO')[0].kind).toBe('satellite');
    expect(textHitsOf(['dsn-MRO', 'dsn-VGR1'], new Map([[mro.id, mro], [vgr.id, vgr]])).map((h) => h.kind)).toEqual(['satellite', 'probe']);
  });

  it('the type suggestions and the category chips count the same entities', () => {
    const all = [mro, vgr, rec('s', 'satellite', 'EARTH')];
    expect(Object.fromEntries(facetCounts(all).kinds)).toEqual({ satellite: 2, probe: 1 });
    expect(Object.fromEntries(categoryCounts(all))).toMatchObject({ satellites: 2, probes: 1 });
  });
});

describe('a saved type:probe term keeps working on what is still a probe', () => {
  it('hide type:probe leaves an orbiter visible and hides a heliocentric probe; only type:probe is the reverse', () => {
    const mro = rec('dsn-MRO', 'probe', 'MARS', sampled('MARS:inertial', 3800));
    const vgr = rec('dsn-VGR1', 'probe', 'EARTH', sampled('EARTH:inertial', 2.5e10));
    const q = (effect: 'only' | 'hide'): Query => ({ terms: [termFromWord('type:probe', effect)!] });
    const ctx = { focus: NO_FOCUS };
    expect(classify(mro, q('hide'), ctx)).toBe('off');
    expect(classify(vgr, q('hide'), ctx)).toBe('hide');
    expect(isDrawn(classify(mro, q('only'), ctx))).toBe(false);
    expect(isDrawn(classify(vgr, q('only'), ctx))).toBe(true);
  });
});
