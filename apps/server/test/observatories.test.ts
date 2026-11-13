import { describe, expect, it } from 'vitest';
import { GROUND_OBSERVATORIES, HUBBLE_NORAD, observatoryOf, type Omm } from '@eio/core';
import { satelliteEntity } from '../src/connectors/celestrak';
import { DSN_STATIONS, DSN_STATION_OBSERVATORY, DSN_TARGETS, probeEntity } from '../src/connectors/dsn-targets';
import { groundObservatoryEntity } from '../src/connectors/observatories';

const omm = (norad: number, name: string): Omm => ({
  OBJECT_NAME: name, OBJECT_ID: '1990-037B', EPOCH: '2026-01-01T00:00:00.000', MEAN_MOTION: 15.1, ECCENTRICITY: 0.0002, INCLINATION: 28.47,
  RA_OF_ASC_NODE: 100, ARG_OF_PERICENTER: 90, MEAN_ANOMALY: 10, EPHEMERIS_TYPE: 0, CLASSIFICATION_TYPE: 'U', NORAD_CAT_ID: norad, ELEMENT_SET_NO: 999,
  REV_AT_EPOCH: 1, BSTAR: 0.0001, MEAN_MOTION_DOT: 0, MEAN_MOTION_DDOT: 0,
});

describe('observatory entities', () => {
  it('marks Hubble (NORAD 20580) as a space observatory and no other satellite', () => {
    const hst = satelliteEntity(omm(HUBBLE_NORAD, 'HST'), 'active');
    expect(observatoryOf(hst)).toMatchObject({ site: 'space', survey: 'CDS/P/DSS2/color' });
    expect(hst.id).toBe('sat-20580');
    expect(observatoryOf(satelliteEntity(omm(25545, 'SOMETHING'), 'active'))).toBeNull();
  });

  it('marks JWST, TESS and Chandra probes as space observatories, other probes not', () => {
    for (const code of ['JWST', 'TESS', 'CHDR']) expect(observatoryOf(probeEntity(code))?.site, code).toBe('space');
    expect(observatoryOf(probeEntity('CHDR'))?.bands).toEqual(['x-ray']);
    expect(observatoryOf(probeEntity('VGR1'))).toBeNull();
    expect(Object.keys(DSN_TARGETS).filter((c) => observatoryOf(probeEntity(c)))).toEqual(['JWST', 'TESS', 'CHDR']);
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
    expect(DSN_STATION_OBSERVATORY).toEqual({ site: 'ground', bands: ['radio'], survey: null });
  });
});
