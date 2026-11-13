import { useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_HIPS_SURVEY } from '@eio/core';
import { ALADIN_VERSION, createSkyView, loadAladin, type SkyView as AladinView } from '../lib/aladin';
import { mirrors } from '../lib/hips-mirror';
import { SURVEYS, observatoryRows, skyTarget, surveyOf } from '../lib/observatories';
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
  // the working server of the chosen survey (see lib/hips-mirror.ts): undefined while probing, null when none answers
  const [surveyUrl, setSurveyUrl] = useState<string | null | undefined>(undefined);
  // true once any survey has a server: the Aladin view then stays up while later surveys are probed or unavailable
  const [resolvedOnce, setResolvedOnce] = useState(false);
  const step = zenithStep(useSimNow(1000));

  const target = useMemo(() => (row ? skyTarget(row, step) : null), [row, step]);
  const latest = useRef({ target, surveyUrl });
  latest.current = { target, surveyUrl };

  // find a server that serves this survey before Aladin is pointed at it
  useEffect(() => {
    let cancelled = false;
    setSurveyUrl(undefined);
    const s = surveyOf(survey);
    if (!s) {
      setSurveyUrl(null);
      return;
    }
    void mirrors.pick(s.id, s.urls).then((url) => {
      if (cancelled) return;
      setSurveyUrl(url);
      if (url) setResolvedOnce(true);
    });
    return () => {
      cancelled = true;
    };
  }, [survey]);

  // the user takes the view: dragging or zooming ends "Follow zenith", else the next 5 s step of sim time would snap it back
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const stop = () => setFollow(false);
    el.addEventListener('pointerdown', stop, true);
    el.addEventListener('wheel', stop, { passive: true, capture: true });
    return () => {
      el.removeEventListener('pointerdown', stop, true);
      el.removeEventListener('wheel', stop, true);
    };
  }, []);

  // another observatory in the same window: its default survey and a fresh follow
  useEffect(() => {
    setSurvey(row?.meta.survey ?? DEFAULT_HIPS_SURVEY);
    setFollow(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [obsId]);

  // create the view once the observatory has imagery (the host div is always rendered, so a row that qualifies late still
  // initialises); Aladin has no destroy call, so unmounting empties its element
  // (created once the first survey server is known, so Aladin never resolves a survey id itself)
  const usable = !!row?.imagery && resolvedOnce;
  useEffect(() => {
    if (!usable) return;
    let cancelled = false;
    const el = host.current;
    loadAladin().then(
      (A) => {
        if (cancelled || !el) return;
        const { target: t, surveyUrl: s } = latest.current;
        if (!s) return;
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
    if (surveyUrl) view.current?.setSurvey(surveyUrl);
  }, [surveyUrl, load.state]);

  const none = !row ? 'This observatory is not in the catalogue.' : !row.imagery ? `${row.name} observes in ${row.meta.bands.join(', ') || 'radio'}: there is no sky imagery to show.` : null;
  const surveyDown = surveyUrl === null ? `${surveyOf(survey)?.label ?? survey} is unavailable right now: none of its servers answered. Try another survey.` : null;

  return (
    <div className="sky">
      <div className="sky-aladin" ref={host} />
      {none && <div className="sky-msg">{none}</div>}
      {!none && surveyDown && <div className="sky-msg sky-err" role="alert">{surveyDown}</div>}
      {!none && !surveyDown && surveyUrl === undefined && <div className="sky-msg">Finding a server for {surveyOf(survey)?.label ?? survey}...</div>}
      {!none && !surveyDown && surveyUrl !== undefined && load.state === 'loading' && <div className="sky-msg">Loading Aladin Lite {ALADIN_VERSION}...</div>}
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
