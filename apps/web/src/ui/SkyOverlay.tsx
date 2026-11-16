import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ALADIN_VERSION, MAX_FOV_DEG, type SkyViewPose } from '../lib/aladin';
import { SURVEYS, coverageNote, observatoryRows, surveyOf, surveyPlan } from '../lib/observatories';
import { aimForHold, followDue, holdFromCentre, movedByOthers, type HeldAltAz } from '../lib/sky-follow';
import { fallbackNote } from '../lib/survey-fallback';
import { shouldAim, skyCoversScene } from '../lib/sky-mode';
import { maxVFovFor, poseFromLook, vFovToHFov } from '../lib/sky-pose';
import {
  ZOOM_PULL_BACK_MS, ZOOM_SCENE_MS, effectiveTransition, zoomAladinFov, zoomNarrowFov, zoomSceneFov, ZOOM_NARROW_FACTOR,
} from '../lib/sky-transition';
import { clock, runtime } from '../state/runtime';
import { useStore } from '../state/store';
import { useView } from '../state/view';
import { SkyDriver } from './sky-driver';

type FpPose = NonNullable<ReturnType<NonNullable<typeof runtime.camera>['firstPersonPose']>>;

const reducedMotion = (): boolean => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** The sky pose of the first-person camera now (J2000 centre, horizontal field, position angle of screen-up). */
function poseOf(p: FpPose): SkyViewPose {
  return poseFromLook(p.dir, clock.now(), p.vFovDeg, p.aspect, p.up);
}

const failText = (e: unknown): string => {
  const why = (e instanceof Error ? e.message : String(e)).trim();
  return `The sky view could not start: ${why}${/[.!?]$/.test(why) ? '' : '.'} You are still looking from the observatory.`;
};

/**
 * The Sky view: Aladin Lite (CDS, loaded on first use, see lib/aladin.ts) filling the scene area, pointed where the first-person
 * camera looks. Mounted inside SceneView's `.scene`, over the canvas and the labels and under the toolbar and HUD. The Aladin
 * instance is created once and then stays mounted, hidden, for the session (Aladin has no destroy call).
 *
 * The phases (lib/sky-mode.ts) and what happens in each:
 * - flying: Aladin Lite and a survey server load while the camera blends into the first-person view (1.5 s); Aladin is created
 *   already pointed where the camera will end up, so its first tiles arrive in time. When the blend has ended: `settled`.
 * - entering: the pose is read once more (the camera may have been turned meanwhile), Aladin is aimed (centre, field of view,
 *   rotation) and the chosen transition (Settings > Sky view) reveals it. Then the scene stops drawing (`setPaused`).
 * - on: Aladin is live (its own drag and zoom); no continuous sync with the scene.
 * - leaving: the scene draws again, the first-person view is left (the camera flies back to the Earth view under the transition)
 *   and the transition runs in reverse.
 * - off: everything is back to the plain scene; the scene is never left paused.
 * A failure (Aladin, no survey server at all, no WebGL2, the 12 s limit) leaves the first-person view and shows a message. One
 * survey without a server does not: the first survey of the observatory's list (then the all-sky fallbacks) that has one is used and
 * the bar says which (lib/survey-fallback.ts).
 *
 * Follow (ground sites): while on, the view keeps the altitude and azimuth it has while the sky turns (sim time moves),
 * re-aimed only when the sky has turned enough to matter (lib/sky-follow.ts). It starts on, a drag or the wheel inside Aladin (or
 * anything else that moves the view) turns it off, and the bar's Follow button turns it on again from where the view is.
 *
 * `annotations` is the mount point for a layer drawn over the Aladin canvas (same box, pointer events pass through); it can
 * project sky positions to pixels with `liveSkyView()` (lib/aladin.ts) `world2pix` / `pix2world`.
 */
export function SkyOverlay({ annotations }: { annotations?: ReactNode }) {
  const phase = useView((s) => s.sky.phase);
  const obsId = useView((s) => s.sky.obsId);
  const error = useView((s) => s.sky.error);
  const dispatch = useView((s) => s.skyDispatch);
  const covers = skyCoversScene(phase) || phase === 'leaving';
  const root = useRef<HTMLDivElement>(null);
  const curtain = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const scan = useRef<HTMLDivElement>(null);
  const driver = useRef<SkyDriver | null>(null);
  // the observatory as one string (site|lat|lon|surveys), so a moving space telescope does not re-render the overlay
  const geo = useStore((s) => {
    const r = obsId ? s.entities.get(obsId) : undefined;
    const row = r ? observatoryRows([r])[0] : undefined;
    return row ? [row.meta.site, row.latDeg ?? '', row.lonDeg ?? '', row.meta.surveys.join(',')].join('|') : '';
  });
  const [site, latS, lonS, surveysS] = geo.split('|');
  const lat = latS === '' || latS === undefined ? undefined : Number(latS);
  const lon = lonS === '' || lonS === undefined ? undefined : Number(lonS);
  const ownSurveys = surveysS ? surveysS.split(',') : [];
  const canFollow = site === 'ground' && lat !== undefined && lon !== undefined;
  const [survey, setSurvey] = useState<string>('');
  const [surveyError, setSurveyError] = useState<string | null>(null);
  const [surveyNote, setSurveyNote] = useState<string | null>(null);
  const [down, setDown] = useState<string[]>([]);
  const [follow, setFollow] = useState(false);
  const pick = useRef(0);

  const drv = (): SkyDriver => (driver.current ??= new SkyDriver({ host: host.current!, curtain: curtain.current!, scan: scan.current! }));

  // flying / loading: load Aladin and the survey server, create the view, and watch for the camera to settle
  const waiting = phase === 'flying' || phase === 'loading';
  useEffect(() => {
    if (!waiting || !obsId) return;
    let cancelled = false;
    let aimed = false;
    const d = drv();
    d.setActive(true); // a hidden view is parked: the survey tiles load during the camera blend, so it runs from now on
    const rec = useStore.getState().entities.get(obsId);
    const plan = surveyPlan((rec ? observatoryRows([rec])[0]?.meta.surveys : null) ?? []);
    setSurvey(plan.own[0] ?? plan.fallbacks[0]);
    setSurveyError(null);
    setSurveyNote(null);
    setDown([]);
    d.prepare(plan, () => {
      // no pose yet (a second start: the camera has not drawn a frame in the first-person view): nothing is aimed, the poll below does it
      const p = runtime.camera?.firstPersonPose();
      if (p) aimed = true;
      return p ? poseOf(p) : null;
    }).then(
      (r) => {
        if (cancelled) return;
        if (r) {
          setSurvey(r.used);
          setDown(r.unavailable);
          setSurveyNote(fallbackNote(surveyOf(r.requested)?.label ?? r.requested, surveyOf(r.used)?.label ?? r.used, r.used === r.requested));
        }
        dispatch({ type: 'ready' });
      },
      (e: unknown) => { if (!cancelled) dispatch({ type: 'failed', message: failText(e) }); },
    );
    const poll = setInterval(() => {
      const p = runtime.camera?.firstPersonPose();
      if (p && shouldAim(p, !!d.view, aimed)) {
        aimed = true;
        d.aim(poseOf(p)); // the first real pose: the view (and its prefetch) is turned there once, never to a made-up place
      }
      if (p?.settled) {
        clearInterval(poll);
        dispatch({ type: 'settled' });
      }
    }, 50);
    return () => {
      cancelled = true;
      clearInterval(poll);
      d.invalidate(); // a prepare still waiting for the library or a survey server must not touch the view later
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting, obsId]);

  // the first-person view is HELD while the sky view is entering or on: a body selected on the sky map neither ends it nor flies the
  // camera. Releasing it (leaving, a failure) ends the view at the current selection when that is not the observatory
  // (SceneController.setFirstPersonHold). Declared before the phase effects below, so a leave releases it before it leaves.
  const held = phase === 'entering' || phase === 'on';
  useLayoutEffect(() => {
    if (!held) return;
    runtime.camera?.setFirstPersonHold(true);
    return () => runtime.camera?.setFirstPersonHold(false);
  }, [held]);

  // entering: aim Aladin at where the camera looks now and run the transition; then stop drawing the scene
  useLayoutEffect(() => {
    if (phase !== 'entering') return;
    const d = drv();
    const cam = runtime.camera;
    let first = cam?.firstPersonPose();
    if (cam && first) {
      // the viewer cannot show more than MAX_FOV_DEG across: cut the scene's own field to it, so both views still match
      const maxV = maxVFovFor(MAX_FOV_DEG, first.aspect);
      if (first.vFovDeg > maxV) {
        cam.setFirstPersonLook(first.dir, maxV);
        first = cam.firstPersonPose() ?? first;
      }
    }
    const pose = first;
    if (!cam || !pose || !d.view) {
      dispatch({ type: 'failed', message: failText(new Error('The camera or the sky viewer is not available.')) });
      return;
    }
    let cancelled = false;
    const sky = poseOf(pose);
    const kind = effectiveTransition(useView.getState().skyTransition, reducedMotion());
    const finish = () => {
      if (cancelled) return;
      d.settle();
      cam.setPaused(true);
      dispatch({ type: 'entered' });
    };
    if (kind === 'zoom') {
      // the scene narrows toward the look direction, Aladin (at the narrowed field) fades in, then pulls back to the real one
      const narrowH = vFovToHFov(zoomNarrowFov(pose.vFovDeg), pose.aspect);
      d.aim({ ...sky, hFovDeg: narrowH });
      const fade = d.curtain('zoom', 'in', ZOOM_SCENE_MS);
      void (async () => {
        await d.tween(ZOOM_SCENE_MS, (p) => cam.setFirstPersonLook(pose.dir, zoomSceneFov(pose.vFovDeg, p)));
        await fade;
        if (cancelled) return;
        await d.tween(ZOOM_PULL_BACK_MS, (p) => d.view?.setFov(zoomAladinFov(narrowH, sky.hFovDeg, p)));
        finish();
      })();
    } else {
      d.aim(sky);
      void d.curtain(kind, 'in').then(finish);
    }
    return () => {
      cancelled = true;
      d.cancelTween();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase === 'entering']);

  // leaving: draw the scene again, leave the first-person view (the camera flies back to the Earth view) and reverse the transition
  useLayoutEffect(() => {
    if (phase !== 'leaving') return;
    const d = drv();
    d.invalidate();
    let cancelled = false;
    const done = () => { if (!cancelled) dispatch({ type: 'left' }); };
    runtime.camera?.setPaused(false);
    runtime.camera?.leaveFirstPerson();
    const kind = effectiveTransition(useView.getState().skyTransition, reducedMotion());
    const back = d.reverse(); // the entering transition was still running: turn it around
    if (back) {
      void back.then(done);
    } else if (kind === 'zoom') {
      const full = d.view?.fov() ?? 60;
      const narrow = Math.max(0.01, full * ZOOM_NARROW_FACTOR);
      void d.tween(ZOOM_PULL_BACK_MS, (p) => d.view?.setFov(zoomAladinFov(narrow, full, 1 - p))).then(() => (cancelled ? undefined : d.curtain('zoom', 'out'))).then(done);
    } else {
      void d.curtain(kind, 'out').then(done);
    }
    return () => {
      cancelled = true;
      d.cancelTween();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase === 'leaving']);

  // off: nothing inline or animated is left on the curtain, and the scene is drawing (also after a failure)
  useLayoutEffect(() => {
    if (phase !== 'off') return;
    driver.current?.invalidate();
    driver.current?.cancelTween();
    driver.current?.settle();
    driver.current?.setActive(false); // nothing of it is shown: park its render loop
    runtime.camera?.setPaused(false);
  }, [phase]);

  // follow: on when the sky view opens (a ground site), off for a space telescope
  const isOn = phase === 'on';
  useEffect(() => {
    setFollow(isOn && canFollow);
  }, [isOn, canFollow, obsId]);

  // while following: hold the altitude and azimuth the centre has now, re-aim as the sim clock turns the sky
  useEffect(() => {
    if (!isOn || !follow || !canFollow || lat === undefined || lon === undefined) return;
    const d = drv();
    const v = d.view;
    const c = v?.center();
    if (!v || !c) return;
    const held: HeldAltAz = holdFromCentre(c.raDeg, c.decDeg, clock.now(), lat, lon);
    let lastSim: number | null = clock.now();
    let lastReal = performance.now();
    let aimed = c;
    const stop = d.watchUser(() => setFollow(false));
    const timer = setInterval(() => {
      const fov = v.fov() ?? 60;
      const cur = v.center();
      if (cur && movedByOthers(aimed, cur, fov)) { setFollow(false); return; } // a marker click or anything else moved the view
      const sim = clock.now(), real = performance.now();
      if (!followDue(lastSim, sim, lastReal, real, fov)) return;
      const a = aimForHold(held, sim, lat, lon);
      v.aim(a.raDeg, a.decDeg, a.rotationDeg);
      aimed = { raDeg: a.raDeg, decDeg: a.decDeg };
      lastSim = sim;
      lastReal = real;
    }, 100);
    return () => { clearInterval(timer); stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOn, follow, canFollow, lat, lon]);

  // a survey chosen in the picker: shown selected only when its server answers; one that is down leaves the view as it is and says so
  const chooseSurvey = (id: string) => {
    const seq = ++pick.current;
    setSurveyError(null);
    drv().useSurvey(id).then(
      () => {
        if (seq !== pick.current) return;
        setSurvey(id);
        setSurveyNote(null);
        setDown((x) => x.filter((y) => y !== id));
      },
      (e: unknown) => {
        if (seq !== pick.current) return;
        setDown((x) => (x.includes(id) ? x : [...x, id]));
        setSurveyError(e instanceof Error ? e.message : String(e));
      },
    );
  };
  const mark = (id: string) => (down.includes(id) ? ' - unavailable' : '');
  const own = surveyPlan(ownSurveys).own;
  const cover = coverageNote(surveyOf(survey));

  return (
    <>
      <div ref={root} className="sky-overlay" data-phase={phase} aria-hidden={!covers} aria-label="Sky view" role="region">
        <div ref={curtain} className="sky-curtain">
          <div ref={host} className="sky-aladin" />
          {/* mount point for the annotation layer: same box as the Aladin canvas, pointer events pass through */}
          <div className="sky-annotations" data-slot="annotations">{annotations}</div>
          <div className="sky-bar">
            <select className="sky-select" value={survey} onChange={(e) => chooseSurvey(e.target.value)} aria-label="Sky survey" title="Survey (HiPS) shown">
              {own.length > 0 && (
                <optgroup label="This observatory">
                  {own.map((id) => <option key={id} value={id}>{surveyOf(id)?.label} ({surveyOf(id)?.band}){mark(id)}</option>)}
                </optgroup>
              )}
              <optgroup label="All surveys">
                {SURVEYS.filter((s) => !own.includes(s.id)).map((s) => <option key={s.id} value={s.id}>{s.label} ({s.band}){mark(s.id)}</option>)}
              </optgroup>
            </select>
            {canFollow && (
              <button className="sky-follow" aria-pressed={follow} onClick={() => setFollow((f) => !f)}
                title={follow ? 'Keeps the same altitude and azimuth while the sky turns; drag or zoom to stop' : 'Hold the current altitude and azimuth while the sky turns'}>
                Follow
              </button>
            )}
            <span className="sky-credit">Aladin Lite, CDS</span>
            {(surveyNote || cover || surveyError) && (
              <div className="sky-notes">
                {surveyError && <div className="sky-note sky-err" role="alert">{surveyError}</div>}
                {surveyNote && <div className="sky-note" role="status">{surveyNote}</div>}
                {cover && <div className="sky-note" role="status">{cover}</div>}
              </div>
            )}
          </div>
        </div>
        <div ref={scan} className="sky-scan" aria-hidden="true" />
      </div>
      {waiting && <div className="sky-status mono" role="status">Preparing the sky view (Aladin Lite {ALADIN_VERSION})...</div>}
      {error && (
        <div className="sky-error" role="alert">
          <span>{error}</span>
          <button className="key" onClick={() => dispatch({ type: 'clearError' })} aria-label="Dismiss this message" title="Dismiss">&times;</button>
        </div>
      )}
    </>
  );
}
