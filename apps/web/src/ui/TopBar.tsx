import { useEffect, useRef, useState } from 'react';
import { fmtUtc } from '../lib/format';
import { bodyCentre, sameCentre } from '../lib/frame';
import {
  digitsOnly, offsetFields, offsetMs, parseOffsetFields, parseOffsetText, simTimeAt, type OffsetFields,
} from '../lib/time-offset';
import { SPEEDS, fmtRateLabel, signedRate, splitRate, type RatePref } from '../lib/time-rate';
import { clock } from '../state/runtime';
import { useStore } from '../state/store';
import { CredentialsPanel } from './CredentialsPanel';
import { HealthIndicator } from './HealthIndicator';
import { useSimNow } from './hooks';

/** Views the app can centre on; Mars has no ephemeris or map yet. */
const BODIES: [string, string | null][] = [['Earth', 'EARTH'], ['Moon', 'MOON'], ['Sun', 'SUN'], ['Mars', null]];

type FieldKey = 'days' | 'hours' | 'minutes' | 'seconds';
const FIELDS: { key: FieldKey; label: string; ph: string; max: number }[] = [
  { key: 'days', label: 'days', ph: 'dd', max: 5 },
  { key: 'hours', label: 'hours', ph: 'hh', max: 4 },
  { key: 'minutes', label: 'minutes', ph: 'mm', max: 4 },
  { key: 'seconds', label: 'seconds', ph: 'ss', max: 4 },
];

/** Field texts being edited; while this exists the live value never overwrites the inputs. */
type Edit = OffsetFields & { dirty: boolean };

export function TopBar() {
  const snap = useStore((s) => s.clock);
  const frame = useStore((s) => s.frame);
  const setFrame = useStore((s) => s.setFrame);
  const now = useSimNow(200); // also re-renders the offset fields about 5 times a second
  const [pref, setPref] = useState<RatePref>({ speed: 1, reverse: false });
  const [edit, setEditState] = useState<Edit | null>(null);
  // the ref is the source of truth so that Enter followed by blur cannot commit twice
  const editRef = useRef<Edit | null>(null);
  const setEdit = (e: Edit | null) => { editRef.current = e; setEditState(e); };

  const live = snap.mode === 'live';
  const paused = snap.mode === 'paused';
  // speed and direction: the clock's own while it runs, the last chosen one while live or paused
  const cur = snap.mode === 'scrubbed' ? splitRate(snap.rate, pref) : pref;
  useEffect(() => {
    if (snap.mode === 'scrubbed') setPref((p) => (p.speed === Math.abs(snap.rate) && p.reverse === snap.rate < 0 ? p : splitRate(snap.rate, p)));
  }, [snap.mode, snap.rate]);

  // both reads in one go, so the offset does not jitter with the 200 ms refresh
  const wallNow = Date.now();
  const liveOffset = offsetMs(clock.now(), wallNow);
  const shown: OffsetFields = edit ?? offsetFields(liveOffset);

  const commit = () => {
    const e = editRef.current;
    setEdit(null);
    if (!e || !e.dirty) return;
    const off = parseOffsetFields(e);
    const s = clock.snapshot();
    if (s.mode === 'live') {
      if (off !== 0) clock.seek(simTimeAt(Date.now(), off), 1);
    } else clock.seek(simTimeAt(Date.now(), off), s.mode === 'paused' ? 0 : s.rate);
  };

  const flipSign = () => {
    const e = editRef.current ?? { ...offsetFields(offsetMs(clock.now(), Date.now())), dirty: false };
    const next: Edit = { ...e, sign: e.sign === 1 ? -1 : 1, dirty: true };
    setEdit(next);
    if (parseOffsetFields(next) !== 0) commit(); // a non-zero offset flips straight away
  };

  const onField = (key: FieldKey, max: number, text: string) => {
    const base: Edit = editRef.current ?? { ...offsetFields(offsetMs(clock.now(), Date.now())), dirty: false };
    if (text.includes(':')) {
      const ms = parseOffsetText(text.replace(/\s/g, ''));
      if (ms !== null) { setEdit({ ...offsetFields(ms), dirty: true }); return; }
    }
    const sign = text.includes('-') || text.includes('−') ? -1 : text.includes('+') ? 1 : base.sign;
    setEdit({ ...base, sign, [key]: digitsOnly(text, max), dirty: true });
  };

  const choosePlay = () => (paused ? clock.seek(clock.now(), signedRate(cur.speed, cur.reverse)) : clock.pause());
  const chooseSpeed = (speed: number) => {
    setPref({ speed, reverse: cur.reverse });
    if (live && speed === 1 && !cur.reverse) return; // already x1
    if (paused) clock.seek(clock.now(), signedRate(speed, cur.reverse));
    else clock.setRate(signedRate(speed, cur.reverse));
  };
  const toggleRewind = () => {
    const reverse = !cur.reverse;
    setPref({ speed: cur.speed, reverse });
    if (!paused) clock.setRate(signedRate(cur.speed, reverse)); // paused: only the direction PLAY will use changes
  };
  const goLive = () => {
    setPref({ speed: 1, reverse: false });
    setEdit(null);
    clock.goLive();
  };

  const modeLabel = fmtRateLabel(snap.mode, snap.rate);
  const rewinding = !live && cur.reverse;

  return (
    <header className="topbar">
      <div className="brand">
        <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.4" /><circle cx="8" cy="8" r="2" fill="currentColor" /></svg>
        <span className="brand-text"><b>EYES</b>IN<b>ORBIT</b></span>
      </div>

      <div className="bodies" role="tablist" aria-label="Body">
        {BODIES.map(([name, id]) => (
          <button
            key={name} role="tab" aria-selected={!!id && sameCentre(frame, bodyCentre(id))} disabled={!id}
            className={id && sameCentre(frame, bodyCentre(id)) ? 'btn active' : 'btn'}
            onClick={() => id && setFrame(bodyCentre(id), { fly: true })}
            title={id ? `Set the frame of reference to the ${name}: the view centres on it, and orbit lines, trails, paths and readouts are relative to it` : `${name} view: not available yet`}>
            {name.toUpperCase()}
          </button>
        ))}
      </div>

      <div className="clock">
        <span className={`mode ${live ? 'ok' : paused ? 'warn' : 'accent'}`} title={live ? 'Real time' : paused ? 'Time is stopped' : rewinding ? 'Time runs backwards' : 'Time runs forwards'}>{modeLabel}</span>
        <span className="utc mono">{fmtUtc(now)}<small> UTC</small></span>
      </div>

      <div className="controls">
        <button className={live ? 'btn active' : 'btn'} onClick={goLive} title="Real time at x1">LIVE</button>
        <button className="btn" onClick={choosePlay} title={paused ? 'Resume at the chosen speed and direction' : 'Stop time'}>
          {paused ? 'PLAY' : 'PAUSE'}
        </button>
        <button
          className={rewinding ? 'btn rew active' : 'btn rew'} aria-pressed={rewinding} onClick={toggleRewind}
          title="Rewind: run time backwards at the selected speed (click again for forwards)">
          &#9664;&#9664;<span className="rew-text"> REW</span>
        </button>
        <div className="speeds" role="group" aria-label="Speed">
          {SPEEDS.map((r) => (
            <button key={r} className={!live && cur.speed === r ? 'btn active' : 'btn'} onClick={() => chooseSpeed(r)} title={`${r} s of simulation time per real second`}>
              &times;{r}
            </button>
          ))}
        </div>

        <div
          className={edit ? 'offset editing' : 'offset'} role="group"
          title="Simulation time relative to now, +/-dd:hh:mm:ss. Type a value and press Enter (or leave the field) to jump there"
          onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) commit(); }}>
          <button className="sign" type="button" onClick={flipSign} aria-label={shown.sign < 0 ? 'Behind now (click for ahead)' : 'Ahead of now (click for behind)'}>
            {shown.sign < 0 ? '−' : '+'}
          </button>
          {FIELDS.map((f, i) => (
            <span key={f.key} className="tf-wrap">
              {i > 0 && <i>:</i>}
              <input
                className={`tf tf-${f.key}`} type="text" inputMode="numeric" autoComplete="off" spellCheck={false}
                value={shown[f.key]} placeholder={f.ph} aria-label={`Offset from now, ${f.label}`} title={f.label}
                onFocus={(e) => {
                  // freeze the display for as long as a field has focus
                  if (!editRef.current) setEdit({ ...offsetFields(offsetMs(clock.now(), Date.now())), dirty: false });
                  e.target.select();
                }}
                onChange={(e) => onField(f.key, f.max, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { commit(); e.currentTarget.blur(); }
                  else if (e.key === 'Escape') { setEdit(null); e.currentTarget.blur(); }
                }}
              />
            </span>
          ))}
        </div>
      </div>

      <CredentialsPanel />
      <HealthIndicator />
    </header>
  );
}
