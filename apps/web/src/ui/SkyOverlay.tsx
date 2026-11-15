import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { DEFAULT_HIPS_SURVEY } from '@eio/core';
import { ALADIN_VERSION, type SkyViewPose } from '../lib/aladin';
import { SURVEYS, observatoryRows } from '../lib/observatories';
import { skyCoversScene } from '../lib/sky-mode';
import { poseFromLook, vFovToHFov } from '../lib/sky-pose';
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
 * A failure (Aladin, no survey server, no WebGL2, the 12 s limit) leaves the first-person view and shows a message.
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
  const [survey, setSurvey] = useState<string>(DEFAULT_HIPS_SURVEY);
  const [surveyError, setSurveyError] = useState<string | null>(null);

  const drv = (): SkyDriver => (driver.current ??= new SkyDriver({ host: host.current!, curtain: curtain.current!, scan: scan.current! }));

  // flying / loading: load Aladin and the survey server, create the view, and watch for the camera to settle
  const waiting = phase === 'flying' || phase === 'loading';
  useEffect(() => {
    if (!waiting || !obsId) return;
    let cancelled = false;
    const d = drv();
    const rec = useStore.getState().entities.get(obsId);
    const surveyId = (rec ? observatoryRows([rec])[0]?.meta.survey : null) ?? DEFAULT_HIPS_SURVEY;
    setSurvey(surveyId);
    setSurveyError(null);
    d.prepare(surveyId, () => {
      const p = runtime.camera?.firstPersonPose();
      return p ? poseOf(p) : null;
    }).then(
      () => { if (!cancelled) dispatch({ type: 'ready' }); },
      (e: unknown) => { if (!cancelled) dispatch({ type: 'failed', message: failText(e) }); },
    );
    const poll = setInterval(() => {
      if (runtime.camera?.firstPersonPose()?.settled) {
        clearInterval(poll);
        dispatch({ type: 'settled' });
      }
    }, 50);
    return () => {
      cancelled = true;
      clearInterval(poll);
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
    const pose = cam?.firstPersonPose();
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
    driver.current?.cancelTween();
    driver.current?.settle();
    runtime.camera?.setPaused(false);
  }, [phase]);

  const chooseSurvey = (id: string) => {
    setSurvey(id);
    setSurveyError(null);
    drv().useSurvey(id).catch((e: unknown) => setSurveyError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <>
      <div ref={root} className="sky-overlay" data-phase={phase} aria-hidden={!covers} aria-label="Sky view" role="region">
        <div ref={curtain} className="sky-curtain">
          <div ref={host} className="sky-aladin" />
          {/* mount point for the annotation layer: same box as the Aladin canvas, pointer events pass through */}
          <div className="sky-annotations" data-slot="annotations">{annotations}</div>
          {surveyError && <div className="sky-msg sky-err" role="alert">{surveyError}</div>}
          <div className="sky-bar">
            <select className="sky-select" value={survey} onChange={(e) => chooseSurvey(e.target.value)} aria-label="Sky survey" title="Survey (HiPS) shown">
              {SURVEYS.map((s) => <option key={s.id} value={s.id}>{s.label} ({s.band})</option>)}
            </select>
            <span className="sky-credit">Aladin Lite, CDS</span>
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
