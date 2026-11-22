import { api } from '../api/client';
import { describeMinorPlanets, useMinorPlanetStatus } from '../state/minor-planet-status';

/**
 * The minor-planet download state and its button, under the layer switch (View menu) and in the feed's pane. Nothing is downloaded
 * until the layer is switched on or the button is pressed; the engine pushes the state while it works.
 */
export function MinorPlanetsControl() {
  const status = useMinorPlanetStatus((s) => s.status);
  const set = useMinorPlanetStatus((s) => s.set);
  const available = useMinorPlanetStatus((s) => s.available);
  const { text, button } = describeMinorPlanets(status);
  const run = () => void api.minorPlanetsDownload({ force: status.state === 'ready' }).then(set, (e: Error) => set({ ...status, state: 'failed', error: e.message }));
  return (
    <div className="mp-control" data-state={status.state}>
      <span className="dim mp-text">{available ? text : 'Starting the data engine…'}</span>
      {button && <button className="chip" disabled={!available} onClick={run}>{button}</button>}
    </div>
  );
}
