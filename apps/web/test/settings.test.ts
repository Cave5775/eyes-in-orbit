import { describe, expect, it } from 'vitest';
import { useLayout } from '../src/state/layout';
import { usePlayerPrefs } from '../src/state/player';
import { atDefaults, restoreDefaults } from '../src/state/settings';
import { useSkin } from '../src/state/skin';
import { useView } from '../src/state/view';

describe('restore defaults', () => {
  it('puts every Settings choice back and leaves the View menu toggles alone', () => {
    useView.setState({ detail: false, surfaceAuto: false, labels: false, skyTransition: 'iris' });
    usePlayerPrefs.setState({ nativeControls: true });
    useLayout.setState({ stored: { left: 400 } });
    useSkin.getState().setSkin('terminal');
    expect(atDefaults()).toBe(false);

    restoreDefaults();

    expect(atDefaults()).toBe(true);
    expect(useView.getState()).toMatchObject({ detail: true, surfaceAuto: true, labels: false, skyTransition: 'crossfade' });
    expect(usePlayerPrefs.getState().nativeControls).toBe(false);
    expect(useLayout.getState().stored).toEqual({});
    expect(useSkin.getState().skin).toBe('classic');
  });

  it('counts the sky view transition: any other than crossfade is not the default', () => {
    restoreDefaults();
    useView.getState().setSkyTransition('sweep');
    expect(atDefaults()).toBe(false);
    restoreDefaults();
    expect(atDefaults()).toBe(true);
    expect(useView.getState().skyTransition).toBe('crossfade');
  });

  it('counts the skin: a skin other than classic is not the default', () => {
    restoreDefaults();
    expect(atDefaults()).toBe(true);
    for (const id of ['terminal', 'mission'] as const) {
      useSkin.getState().setSkin(id);
      expect(atDefaults(), id).toBe(false);
    }
    restoreDefaults();
    expect(atDefaults()).toBe(true);
  });
});
