import type { Api, MinorPlanetStatus } from '../api/types';

/**
 * The minor-planet download is opt-in: it starts when the layer is on (turned on now, or on from an earlier visit) and the engine finds
 * nothing fresh stored, and a download in progress is aborted when the layer is turned off. Returns the unsubscribe function.
 */
export function watchMinorPlanets(
  getApi: () => Pick<Api, 'minorPlanetsStatus' | 'minorPlanetsDownload' | 'minorPlanetsCancel'>,
  view: { getState(): { minorPlanets: boolean }; subscribe(fn: (s: { minorPlanets: boolean }) => void): () => void },
  setStatus: (s: MinorPlanetStatus) => void,
): () => void {
  const begin = () => void getApi().minorPlanetsDownload().then(setStatus, () => undefined);
  void getApi().minorPlanetsStatus().then(setStatus, () => undefined);
  let on = view.getState().minorPlanets;
  if (on) begin();
  return view.subscribe((v) => {
    if (v.minorPlanets === on) return;
    on = v.minorPlanets;
    if (on) begin();
    else void getApi().minorPlanetsCancel().catch(() => undefined);
  });
}
