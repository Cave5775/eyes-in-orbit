import { useCallback, useRef, useState } from 'react';
import { SKINS } from '../lib/skin';
import { useLayout } from '../state/layout';
import { usePlayerPrefs } from '../state/player';
import { atDefaults, restoreDefaults } from '../state/settings';
import { useSkin } from '../state/skin';
import { useView } from '../state/view';
import { useDismiss } from './hooks';

interface Row { key: string; label: string; hint: string; on: boolean; set(on: boolean): void }

/**
 * Top bar Settings (gear): set-and-forget choices, as opposed to the View menu's quick toggles. Each choice is remembered by
 * the store that owns it. Closes on an outside click and on Esc.
 */
export function SettingsMenu() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, root, close, button);

  return (
    <div className="menu-anchor" ref={root}>
      <button
        ref={button} className={open ? 'key icon-key on' : 'key icon-key'} onClick={() => setOpen((o) => !o)}
        aria-expanded={open} aria-haspopup="dialog" aria-label="Settings" title="Settings: appearance, imagery, camera, video and layout preferences">
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor">
          <circle cx="8" cy="8" r="4.6" strokeWidth="1.6" />
          <circle cx="8" cy="8" r="1.7" strokeWidth="1.2" />
          <path d="M8 1v2.4M8 12.6V15M1 8h2.4M12.6 8H15M3.05 3.05l1.7 1.7M11.25 11.25l1.7 1.7M3.05 12.95l1.7-1.7M11.25 4.75l1.7-1.7" strokeWidth="2" />
        </svg>
      </button>
      {open && <Panel />}
    </div>
  );
}

function Panel() {
  const detail = useView((s) => s.detail);
  const surfaceAuto = useView((s) => s.surfaceAuto);
  const native = usePlayerPrefs((s) => s.nativeControls);
  const sized = useLayout((s) => Object.keys(s.stored).length > 0);
  const skin = useSkin((s) => s.skin);
  // the subscriptions above cover every store atDefaults reads
  const defaults = atDefaults();

  const group = (title: string, rows: Row[]) => (
    <fieldset className="menu-group">
      <legend>{title}</legend>
      {rows.map((r) => (
        <label key={r.key} className="menu-row">
          <input type="checkbox" className="switch" checked={r.on} onChange={(e) => r.set(e.target.checked)} />
          <span className="menu-name">{r.label}</span>
          <span className="menu-hint">{r.hint}</span>
        </label>
      ))}
    </fieldset>
  );

  return (
    <div className="popover menu-pop settings-pop" role="dialog" aria-label="Settings">
      <fieldset className="menu-group">
        <legend>Appearance</legend>
        {SKINS.map((s) => (
          <label key={s.id} className="menu-row skin-row">
            <input type="radio" className="radio" name="skin" value={s.id} checked={skin === s.id} onChange={() => useSkin.getState().setSkin(s.id)} />
            <span className="skin-prev" data-preview={s.id} aria-hidden="true"><i /><i /></span>
            <span className="menu-name">{s.label}</span>
            <span className="menu-hint">{s.hint}</span>
          </label>
        ))}
      </fieldset>
      {group('Display', [
        { key: 'detail', label: 'Close-up Earth imagery', hint: 'Stream finer maps below about 2,600 km (uses more data)', on: detail, set: (on) => useView.getState().setDetail(on) },
      ])}
      {group('Camera', [
        {
          key: 'surface', label: 'Surface view near the Earth',
          hint: 'Selecting an object near the Earth turns the camera level with its horizon, north up. S or Surface also changes this',
          on: surfaceAuto, set: (on) => useView.getState().setSurfaceAuto(on),
        },
      ])}
      {group('Video', [
        {
          key: 'native', label: "YouTube's own controls",
          hint: "Players opened from now on show YouTube's control bar instead of the app's strip",
          on: native, set: (on) => usePlayerPrefs.getState().setNativeControls(on),
        },
      ])}
      <fieldset className="menu-group">
        <legend>Layout</legend>
        <div className="menu-row settings-action">
          <span className="menu-name">Panel sizes</span>
          <span className="menu-hint">{sized ? 'Dragged sizes are remembered in this browser' : 'All panels are at their default size'}</span>
          <button className="key" disabled={!sized} onClick={() => useLayout.getState().resetAll()}>Reset</button>
        </div>
      </fieldset>
      <div className="settings-foot">
        <button className="key" disabled={defaults} onClick={restoreDefaults} title="Put every setting above back to how a new browser starts">
          Restore defaults
        </button>
      </div>
    </div>
  );
}
