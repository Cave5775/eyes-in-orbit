import { DEFAULT_SKIN } from '../lib/skin';
import { DEFAULT_SKY_TRANSITION } from '../lib/sky-transition';
import { useLayout } from './layout';
import { usePlayerPrefs } from './player';
import { useSkin } from './skin';
import { useView } from './view';

/** Put the choices the Settings panel lists back to how a new browser starts. View menu toggles are left alone. */
export function restoreDefaults(): void {
  const view = useView.getState();
  view.setDetail(true);
  view.setSurfaceAuto(true);
  view.setSkyTransition(DEFAULT_SKY_TRANSITION);
  usePlayerPrefs.getState().setNativeControls(false);
  useLayout.getState().resetAll();
  useSkin.getState().setSkin(DEFAULT_SKIN);
}

/** Whether every choice `restoreDefaults` covers is already at its default. */
export function atDefaults(): boolean {
  const v = useView.getState();
  return v.detail && v.surfaceAuto && v.skyTransition === DEFAULT_SKY_TRANSITION && !usePlayerPrefs.getState().nativeControls && Object.keys(useLayout.getState().stored).length === 0
    && useSkin.getState().skin === DEFAULT_SKIN;
}
