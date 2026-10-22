import type { ProviderSpec, StateProvider } from '../types';
import { CompositeProvider } from './composite';
import { GeodeticProvider } from './geodetic';
import { KeplerianProvider } from './keplerian';
import { RelativeProvider } from './relative';
import { SampledProvider } from './sampled';
import { Sgp4Provider } from './sgp4';

/** Rebuild a live provider from its serialisable spec (server -> client transport). */
export function providerFromSpec(spec: ProviderSpec): StateProvider {
  switch (spec.type) {
    case 'sgp4':
      return new Sgp4Provider(spec.omm);
    case 'sampled':
      return new SampledProvider(spec.frame, spec.samples, spec.holdEnds, spec.confidence);
    case 'keplerian':
      return new KeplerianProvider(spec.bodyId, spec.elements);
    case 'geodetic':
      return new GeodeticProvider(spec.bodyId, spec.latDeg, spec.lonDeg, spec.altKm);
    case 'relative':
      return new RelativeProvider(spec.parentId, spec.mode, spec.offsetKm, spec.samples);
    case 'composite':
      return new CompositeProvider(spec.segments);
  }
}

export { CompositeProvider, GeodeticProvider, KeplerianProvider, RelativeProvider, SampledProvider, Sgp4Provider };
