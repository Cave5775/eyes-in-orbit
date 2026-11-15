import { describe, expect, it } from 'vitest';
import { useLayout } from '../src/state/layout';
import { usePlayerPrefs } from '../src/state/player';
import { atDefaults, restoreDefaults } from '../src/state/settings';
import { useView } from '../src/state/view';

describe('restore defaults', () => {
  it('puts every Settings choice back and leaves the View menu toggles alone', () => {
    useView.setState({ detail: false, surfaceAuto: false, labels: false });
    usePlayerPrefs.setState({ nativeControls: true });
    useLayout.setState({ stored: { left: 400 } });
    expect(atDefaults()).toBe(false);

    restoreDefaults();

    expect(atDefaults()).toBe(true);
    expect(useView.getState()).toMatchObject({ detail: true, surfaceAuto: true, labels: false });
    expect(usePlayerPrefs.getState().nativeControls).toBe(false);
    expect(useLayout.getState().stored).toEqual({});
  });
});
