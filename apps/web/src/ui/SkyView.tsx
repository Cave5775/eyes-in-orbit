import { useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_HIPS_SURVEY } from '@eio/core';
import { ALADIN_VERSION, createSkyView, loadAladin, type SkyView as AladinView } from '../lib/aladin';
import { SURVEYS, observatoryRows, skyTarget } from '../lib/observatories';
import { zenithStep } from '../lib/sky-frame';
import { useStore } from '../state/store';
import { useSimNow } from './hooks';

type Load = { state: 'loading' } | { state: 'ready' } | { state: 'error'; message: string };

/**
 * Body of the Sky view window: Aladin Lite (CDS, loaded on first use, see lib/aladin.ts) looking at the sky. A ground
 * observatory starts at its zenith and, while "Follow zenith" is on, is re-aimed whenever sim time moves by a 5 s step; a space
 * telescope starts at a default target (no pointing data). Dragging and zooming are Aladin's own.
 */
export function SkyView({ obsId }: { obsId: string }) {
  const rec = useStore((s) => s.entities.get(obsId));
  const row = useMemo(() => (rec ? observatoryRows([rec])[0] : undefined), [rec]);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<AladinView | null>(null);
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [survey, setSurvey] = useState(row?.meta.survey ?? DEFAULT_HIPS_SURVEY);
  const [follow, setFollow] = useState(true);
  const step = zenithStep(useSimNow(1000));

  const target = useMemo(() => (row ? skyTarget(row, step) : null), [row, step]);
  const latest = useRef({ target, survey });
  latest.current = { target, survey };

  // another observatory in the same window: its default survey and a fresh follow
  useEffect(() => {
    setSurvey(row?.meta.survey ?? DEFAULT_HIPS_SURVEY);
    setFollow(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [obsId]);

  // create the view once the observatory has imagery (the host div is always rendered, so a row that qualifies late still
  // initialises); Aladin has no destroy call, so unmounting empties its element
  const usable = !!row?.imagery;
  useEffect(() => {
    if (!usable) return;
    let cancelled = false;
    const el = host.current;
    loadAladin().then(
      (A) => {
        if (cancelled || !el) return;
        const { target: t, survey: s } = latest.current;
        view.current = createSkyView(A, el, { survey: s, raDeg: t?.raDeg ?? 0, decDeg: t?.decDeg ?? 0, fovDeg: 60 });
        setLoad({ state: 'ready' });
      },
      (err: unknown) => {
        if (!cancelled) setLoad({ state: 'error', message: err instanceof Error ? err.message : String(err) });
      },
    );
    return () => {
      cancelled = true;
      view.current = null;
      if (el) el.replaceChildren();
      setLoad({ state: 'loading' });
    };
  }, [usable]);

  // aim: when the observatory changes, and every 5 s step of sim time for a ground site that follows its zenith
  const tracks = !!target?.tracksZenith;
  useEffect(() => {
    if (target && view.current && (tracks ? follow : true)) view.current.gotoRaDec(target.raDeg, target.decDeg);
    // the target object changes every step; the aim should follow only when following (or on a new observatory)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [obsId, load.state, follow && tracks ? step : 0]);

  useEffect(() => {
    view.current?.setSurvey(survey);
  }, [survey, load.state]);

  const none = !row ? 'This observatory is not in the catalogue.' : !row.imagery ? `${row.name} observes in ${row.meta.bands.join(', ') || 'radio'}: there is no sky imagery to show.` : null;

  return (
    <div className="sky">
      <div className="sky-aladin" ref={host} />
      {none && <div className="sky-msg">{none}</div>}
      {!none && load.state === 'loading' && <div className="sky-msg">Loading Aladin Lite {ALADIN_VERSION}...</div>}
      {!none && load.state === 'error' && <div className="sky-msg sky-err" role="alert">{load.message}</div>}
      {!none && <div className="sky-bar">
        <span className="sky-note" title={target?.note}>{target?.note}</span>
        <select className="sky-select" value={survey} onChange={(e) => setSurvey(e.target.value)} aria-label="Sky survey" title="Survey (HiPS) shown">
          {SURVEYS.map((s) => <option key={s.id} value={s.id}>{s.label} ({s.band})</option>)}
        </select>
        {tracks && (
          <label className="sky-follow" title="Re-aim at the zenith as sim time moves">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow zenith
          </label>
        )}
        <span className="sky-credit">Aladin Lite, CDS</span>
      </div>}
    </div>
  );
}
