import { describe, expect, it } from 'vitest';
import { GROUND_OBSERVATORIES, observatoryOf } from '@eio/core';
import { DSN_STATIONS, DSN_STATION_OBSERVATORY, DSN_TARGETS, probeEntity } from '../../../src/engine/connectors/dsn-targets';
import { groundObservatoryEntity } from '../../../src/engine/connectors/observatories';

// the satellite-entity cases (Hubble, XMM, Fermi) arrive with the CelesTrak connector
describe('observatory entities', () => {
  it('marks JWST, TESS, Chandra and Euclid probes as space observatories, other probes not', () => {
    for (const code of ['JWST', 'TESS', 'CHDR', 'EUCL']) expect(observatoryOf(probeEntity(code))?.site, code).toBe('space');
    expect(observatoryOf(probeEntity('CHDR'))?.bands).toEqual(['x-ray']);
    expect(observatoryOf(probeEntity('VGR1'))).toBeNull();
    expect(Object.keys(DSN_TARGETS).filter((c) => observatoryOf(probeEntity(c)))).toEqual(['JWST', 'TESS', 'CHDR', 'EUCL']);
    expect(DSN_TARGETS.EUCL.horizons).toBe('-680');
  });

  it('builds the ground sites as geodetic ground_station entities in the observatory group', () => {
    for (const o of GROUND_OBSERVATORIES) {
      const e = groundObservatoryEntity(o);
      expect(e).toMatchObject({ kind: 'ground_station', bodyId: 'EARTH', group: 'observatory', provider: { type: 'geodetic', latDeg: o.latDeg, lonDeg: o.lonDeg } });
      expect(observatoryOf(e)).toMatchObject({ site: 'ground' });
    }
  });

  it('lists the three DSN complexes as radio observatories without sky imagery', () => {
    expect(DSN_STATIONS).toHaveLength(3);
    expect(DSN_STATION_OBSERVATORY).toEqual({ site: 'ground', bands: ['radio'], surveys: [] });
  });
});
