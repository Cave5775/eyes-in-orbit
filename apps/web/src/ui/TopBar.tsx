import { useState } from 'react';
import { fmtUtc } from '../lib/format';
import { clock } from '../state/runtime';
import { useStore } from '../state/store';
import { HealthIndicator } from './HealthIndicator';
import { useSimNow } from './hooks';

const RATES = [1, 10, 60, 600];
const SCRUB_MIN = 24 * 60;

const BODIES: [string, boolean][] = [['Earth', true], ['Moon', false], ['Mars', false]];

export function TopBar() {
  const snap = useStore((s) => s.clock);
  const now = useSimNow(200);
  const [drag, setDrag] = useState<number | null>(null);

  const offsetMin = Math.max(-SCRUB_MIN, Math.min(SCRUB_MIN, Math.round((now - Date.now()) / 60_000)));
  const value = drag ?? offsetMin;
  const live = snap.mode === 'live';
  const paused = snap.mode === 'paused';
  const modeLabel = live ? 'LIVE' : paused ? 'PAUSED' : `x${snap.rate} SIM`;

  const scrub = (min: number) => {
    setDrag(min);
    clock.seek(Date.now() + min * 60_000, live || paused ? 0 : snap.rate);
  };
  const fmtOffset = (m: number) => `${m < 0 ? '-' : '+'}${String(Math.floor(Math.abs(m) / 60)).padStart(2, '0')}:${String(Math.abs(m) % 60).padStart(2, '0')}`;

  return (
    <header className="topbar">
      <div className="brand">
        <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.4" /><circle cx="8" cy="8" r="2" fill="currentColor" /></svg>
        <b>EYES</b>IN<b>ORBIT</b>
      </div>

      <div className="bodies" role="tablist" aria-label="Body">
        {BODIES.map(([name, enabled]) => (
          <button key={name} role="tab" aria-selected={enabled} disabled={!enabled} className={enabled ? 'btn active' : 'btn'} title={enabled ? name : `${name} view: not available yet`}>
            {name.toUpperCase()}
          </button>
        ))}
      </div>

      <div className="clock">
        <span className={`mode ${live ? 'ok' : paused ? 'warn' : 'accent'}`}>{modeLabel}</span>
        <span className="utc mono">{fmtUtc(now)}<small> UTC</small></span>
      </div>

      <div className="controls">
        <button className={live ? 'btn active' : 'btn'} onClick={() => clock.goLive()}>LIVE</button>
        <button className="btn" onClick={() => (paused ? clock.seek(clock.now(), 1) : clock.pause())}>
          {paused ? 'PLAY' : 'PAUSE'}
        </button>
        {RATES.map((r) => (
          <button key={r} className={!live && !paused && snap.rate === r ? 'btn active' : 'btn'} onClick={() => !(live && r === 1) && clock.setRate(r)}>
            &times;{r}
          </button>
        ))}
        <label className="scrub" title="Scrub simulation time within +/- 24 h of now">
          <span className="mono dim">{fmtOffset(value)}</span>
          <input
            type="range" min={-SCRUB_MIN} max={SCRUB_MIN} step={1} value={value}
            onChange={(e) => scrub(Number(e.target.value))}
            onPointerUp={() => setDrag(null)} onKeyUp={() => setDrag(null)}
            aria-label="Time scrub, minutes from now"
          />
        </label>
      </div>

      <HealthIndicator />
    </header>
  );
}
