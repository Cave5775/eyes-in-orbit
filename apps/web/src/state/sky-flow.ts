import { observatoryRows } from '../lib/observatories';
import { SKY_ENTRY_TIMEOUT_MS, skyBusy } from '../lib/sky-mode';
import { runtime } from './runtime';
import { useStore } from './store';
import { useView } from './view';

/**
 * Starting and leaving the Sky view (the phase machine is lib/sky-mode.ts, mirrored in `useView().sky`; the Aladin work and the
 * animations are ui/SkyOverlay.tsx). Starting puts the camera in the first-person view at the observatory and asks for the
 * `flying` phase; the overlay then loads Aladin while the camera blends in. Leaving is one step back to the Earth view.
 */

/** Does the observatory have sky imagery (a ground or optical/infrared/x-ray/gamma site, not a radio dish)? */
export function hasSkyImagery(obsId: string): boolean {
  const rec = useStore.getState().entities.get(obsId);
  return !!rec && !!observatoryRows([rec])[0]?.imagery;
}

let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * Start the Sky view for observatory `obsId`: select it, stand the camera there and begin the phases. False (nothing changed)
 * when a sky view is already in progress, the observatory has no imagery or no position, or the scene is not mounted. A
 * phase that has not reached `entering` after SKY_ENTRY_TIMEOUT_MS fails with a message and the first-person view stays.
 */
export function startSkyView(obsId: string): boolean {
  const view = useView.getState();
  const cam = runtime.camera;
  if (!cam || skyBusy(view.sky.phase) || !hasSkyImagery(obsId)) return false;
  const store = useStore.getState();
  if (store.selectedId !== obsId) store.selectObject(obsId);
  if (!cam.lookFrom(obsId)) return false;
  // after lookFrom: it ends a first-person view somewhere else first, which would reset the phase
  view.skyDispatch({ type: 'request', obsId });
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    const s = useView.getState();
    if ((s.sky.phase === 'flying' || s.sky.phase === 'loading') && s.sky.obsId === obsId) {
      s.skyDispatch({ type: 'failed', message: 'The sky view took too long to get ready (the sky imagery servers or the network are not answering), so you are still looking from the observatory.' });
    }
  }, SKY_ENTRY_TIMEOUT_MS);
  return true;
}

/**
 * Esc and the Back button: leave the sky view and the first-person view in one step (the observatory stays selected). Before
 * anything is shown (flying, loading) the first-person view is left here; once the view is covering the scene the overlay does it
 * as the reverse transition starts. Ignored while already leaving.
 */
export function leaveSkyView(): void {
  const view = useView.getState();
  const phase = view.sky.phase;
  if (phase === 'off' || phase === 'leaving') return;
  view.skyDispatch({ type: 'leave' });
  if (phase === 'flying' || phase === 'loading') runtime.camera?.leaveFirstPerson();
}
