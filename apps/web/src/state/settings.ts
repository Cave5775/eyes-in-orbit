import { useLayout } from './layout';
import { usePlayerPrefs } from './player';
import { useView } from './view';

/** Put the choices the Settings panel lists back to how a new browser starts. View menu toggles are left alone. */
export function restoreDefaults(): void {
  const view = useView.getState();
  view.setDetail(true);
  view.setSurfaceAuto(true);
  usePlayerPrefs.getState().setNativeControls(false);
  useLayout.getState().resetAll();
}

/** Whether every choice `restoreDefaults` covers is already at its default. */
export function atDefaults(): boolean {
  const v = useView.getState();
  return v.detail && v.surfaceAuto && !usePlayerPrefs.getState().nativeControls && Object.keys(useLayout.getState().stored).length === 0;
}
