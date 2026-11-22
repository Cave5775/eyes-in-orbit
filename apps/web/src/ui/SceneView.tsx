import { useCallback, useEffect, useRef, useState } from 'react';
import { sourceLabel } from '../lib/arrays';
import { fmtDist, fmtPathWindow } from '../lib/format';
import { firstPersonReadout } from '../lib/first-person';
import { CATEGORIES } from '../lib/browser-ui';
import { colorKeyOf, kindLabel } from '../lib/entity';
import { typeOf } from '../lib/view-class';
import { launchOfPathEntity, liftoffMsOf, pathTipText } from '../lib/launch-seek';
import { relatedFor } from '../lib/related';
import { scopeLabel } from '../lib/scope';
import { skyCoversScene } from '../lib/sky-mode';
import { modelDef } from '../scene/models/registry';
import { LabelLayer, type LabelItem } from '../scene/LabelLayer';
import { minorPlanetRecord } from '../scene/minor-planets';
import { rememberPicked } from '../lib/minor-planet-recent';
import { SceneController, type PathLabel, type SceneStats } from '../scene/SceneController';
import { usePanels } from '../state/panels';
import { api } from '../api/client';
import { hasTraverse } from '@eio/core';
import { traverseRetryMs } from '../lib/traverse';
import { clock, runtime, type CameraCommands } from '../state/runtime';
import { jumpToSimTime } from '../state/seek';
import { leaveSkyView } from '../state/sky-flow';
import { useSkin } from '../state/skin';
import { useStore } from '../state/store';
import { useView } from '../state/view';
import { FrameBar } from './FrameBar';
import { PickPopup, type PickItem } from './PickPopup';
import { SkyMarkers } from './SkyMarkers';
import { SkyArchive } from './SkyArchive';
import { SkyOverlay } from './SkyOverlay';

/** The colour key: the nine browser categories, each in its own colour (lib/browser-ui.ts, `--c-<category>`), the same as the dots. */
const LEGEND: readonly [string, string][] = CATEGORIES.map((c) => [c.id, c.label]);

const HELP: [string, string][] = [
  ['Left drag', 'Orbit (surface view: look around the local horizon)'],
  ['Right / Shift drag', 'Pan (surface view: lets go of the followed object and slides along the ground at its height)'],
  ['Wheel / pinch', 'Zoom: step scales with height above the surface'],
  ['Click', 'Select an object; hover for its name. Where several overlap a list opens (highest in the hierarchy first, then newest): wheel or arrows choose, click or Enter selects, Esc closes. Zoomed out, the small objects over a small distant body (Earth under about 80 px wide) are not drawn: a click there selects the body directly. The selection, related and searched-for objects, launch vehicles and pads stay drawn'],
  ['Click a launch path', 'With a launch (or its booster) selected, clicking its drawn trajectory jumps the simulation clock to the moment at that point of the flight (T+ shown while hovering), at the current rate. Objects, the choice list and the Earth always take the click first'],
  ['F', 'Fit the selection and its related objects'],
  ['Shift+F', 'Fit everything visible (respects the search and the hidden groups)'],
  ['S', 'Surface view: the camera is centred on the selected object but oriented to the local surface (level horizon, north-up). On by default for objects near the Earth (orbit, launch, booster, ground); S or Surface switches to the globe view, and that choice is remembered until you press S again'],
  ['Look from here', 'Observatories panel: the camera stands at the selected observatory (a ground site at eye height, a space telescope where it is now) and looks outward with a level horizon. Left drag turns the view, the wheel changes the field of view (1 to 120 degrees), pan is off. Esc or Leave returns to the Earth view you had (the observatory stays selected)'],
  ['Sky view', "Observatories panel (or double-click a row): the camera stands at the observatory and the whole scene area changes into an Aladin Lite sky survey pointed exactly where the camera looks, with the same field of view and a matching horizon. Drag and wheel are Aladin's own, the survey list is at the top left. Esc or Back leaves the sky view and the first-person view in one step, to the Earth view you had (or, with a body selected on the sky map, to that body). The Sun, Moon, planets, dwarf planets, asteroids and moons with a streamed position are ringed and named (View > Labels; dimmed when below the horizon or behind the Earth); hover for RA, Dec, altitude and azimuth and distance, click one to select it and turn the view to it, double-click to select it and leave the sky view with the camera flying to it. Settings > Sky view picks the transition. Observatories with no sky imagery (radio dishes) are disabled"],
  ['Esc', 'Deselect and return to the Earth view (while in the sky view or the first-person view it only leaves them, a second Esc deselects)'],
  ['Follow, Fit, Close-up', 'Camera actions for the selection, in the selection panel on the right. Follow keeps the camera on the object; Fit is the same as F'],
  ['Close-up', 'The close view of the selection. Objects with a 3D model (ISS, launch boosters, one Starlink) turn from a point into the true-size model once the camera is within its distance (ISS 45 km, booster 12 km, satellite 6 km; the point stays until the model is bigger than it); F or Close-up on such a selection flies to it. A lander, rover or aircraft on the Moon, Mars or Titan: the camera flies to 4 km over the site, 45 degrees over the horizon on the Sun side, looking down at it; for Curiosity and Perseverance the view is widened to hold the whole traverse, which is drawn on the surface (every localization NASA has published, ending at the rover) whenever the rover is selected'],
  ['View: Labels', 'Names next to objects, on by default and remembered. The Sun, planets and moons are named when zoomed out (the name fades as the body fills the view); the selection is always named. With a search on (text or tags), the satellites it lets through are named too (at most 48 labels, the ones nearest the screen centre first, overlapping ones left out); objects behind a body are not named'],
  ['View: Highlight', 'Dims everything but the selection, the objects related to it and what the search matches (smaller, fainter points) instead of hiding what the search leaves out. Hidden groups stay hidden. Off by default, remembered'],
  ['View menu (top bar)', 'Labels, highlight, scope (draw everything, or only what is near the camera focus) and the colour legend; and show or hide the launch board, the observatories, the news ticker and the colour legend (the Data streams button next to it opens the feed list and the DSN table); a hidden panel gives its space back to the globe and the choice is remembered'],
  ['Settings (top bar, gear)', 'Set-and-forget choices: close-up Earth imagery, the surface view by default near the Earth, YouTube\'s own player controls, panel sizes back to their defaults, and restore all of these'],
  ['H', 'Show / hide this help'],
];

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || t.isContentEditable);
}

/** ids of the lightweight minor planet entities made by picks, most recent first (lib/minor-planet-recent.ts) */
let pickedRecent: string[] = [];

export function SceneView() {
  const host = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  /** tooltip and snap dot of the trajectory under the cursor (separate from `tip`, which names objects) */
  const pathTip = useRef<HTMLDivElement>(null);
  const pathDot = useRef<HTMLDivElement>(null);
  const labelHost = useRef<HTMLDivElement>(null);
  const scene = useRef<SceneController | null>(null);
  const [stats, setStats] = useState<SceneStats | null>(null);
  const surface = useView((s) => s.surface);
  const help = useView((s) => s.help);
  const firstPerson = useView((s) => s.firstPerson);
  const skyPhase = useView((s) => s.sky.phase);
  const skyCovered = skyCoversScene(skyPhase);
  /** open choice popup for a click on overlapping objects */
  const [pick, setPick] = useState<{ items: PickItem[]; more: number; x: number; y: number } | null>(null);
  const closePick = useCallback(() => setPick(null), []);
  const choosePick = useCallback((id: string) => {
    setPick(null);
    useStore.getState().selectObject(id);
  }, []);
  const highlightPick = useCallback((id: string | null) => scene.current?.setPreview(id), []);
  const showLegend = usePanels((s) => s.visible.legend);
  const selectedId = useStore((s) => s.selectedId);

  // the popup describes where objects were under the cursor: any selection change (a list click, the browser, a hotkey) retires it
  useEffect(() => setPick(null), [selectedId]);

  // a rover's whole traverse (`api.traverse`) is fetched when it is selected; the scene draws it on the planet while it stays selected
  useEffect(() => {
    if (!selectedId || !hasTraverse(selectedId)) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // the server answers 404 until its first poll has stored the traverse: ask again while the rover stays selected (5 s, 15 s, 60 s, then every 5 min)
    const ask = (attempt: number) => {
      void api.traverse(selectedId).catch(() => null).then((t) => {
        if (!live) return;
        if (t) scene.current?.setTraverse(selectedId, t);
        else timer = setTimeout(() => ask(attempt + 1), traverseRetryMs(attempt));
      });
    };
    ask(0);
    return () => { live = false; clearTimeout(timer); };
  }, [selectedId]);

  useEffect(() => {
    const store = useStore;
    // two layers over the canvas: the path's phase labels and the object labels (scene/LabelLayer.ts pools their nodes)
    const pathLayer = new LabelLayer(labelHost.current!, 'path-label mono');
    // an object label carries its category colour (the same as its dot) as a stripe on its left edge
    const objectLayer = new LabelLayer(labelHost.current!, 'scene-label mono', (id) => {
      const rec = store.getState().entities.get(id);
      return rec ? `var(--c-${colorKeyOf(rec)})` : undefined;
    });
    const pathItems: LabelItem[] = [];
    const showPathLabels = (labels: PathLabel[]) => {
      for (let i = 0; i < labels.length; i++) {
        const l = labels[i];
        const item = (pathItems[i] ??= { id: `p${i}`, text: '', x: 0, y: 0 });
        item.text = l.text;
        item.x = l.x + 8;
        item.y = l.y - 9;
      }
      pathLayer.update(pathItems, labels.length);
    };
    const ctl = new SceneController(host.current!, {
      onPick: (id) => store.getState().selectObject(id),
      // a point of the minor planet cloud: a lightweight entity made for just this point, selected through the one selection route
      onPickMinorPlanet: (orbit) => {
        const rec = minorPlanetRecord(orbit, Date.now());
        store.getState().upsertEntities([rec]);
        store.getState().selectObject(rec.id);
        // only the last few stay in the catalogue (and the selection, whatever it is)
        const r = rememberPicked(pickedRecent, rec.id, store.getState().selectedId);
        pickedRecent = r.recent;
        store.getState().removeEntities(r.evict);
      },
      tileUrl: (layer, z, x, y) => api.mapTile(layer, z, x, y),
      onPickMany: (ids, total, x, y) => {
        const ents = store.getState().entities;
        const items: PickItem[] = [];
        for (const id of ids) {
          const rec = ents.get(id);
          if (rec) items.push({ id, name: rec.name, kind: kindLabel(typeOf(rec)), colorKey: colorKeyOf(rec) });
        }
        if (items.length === 1) store.getState().selectObject(items[0].id);
        else if (items.length > 0) setPick({ items, more: total - items.length, x, y });
      },
      onHover: (h) => {
        const el = tip.current;
        if (!el) return;
        const rec = h ? store.getState().entities.get(h.id) : undefined;
        if (!h || !rec) {
          el.style.display = 'none';
          return;
        }
        el.style.display = 'block';
        el.style.transform = `translate(${h.x + 14}px, ${h.y + 14}px)`;
        el.textContent = `${rec.name}  ·  ${kindLabel(typeOf(rec))}`;
      },
      onPathHover: (h) => {
        const el = pathTip.current, dot = pathDot.current;
        if (!el || !dot) return;
        if (!h) {
          el.style.display = dot.style.display = 'none';
          return;
        }
        const s = store.getState();
        const rec = s.entities.get(h.id);
        const launch = launchOfPathEntity(s.launches, h.id, rec?.parentId);
        el.style.display = dot.style.display = 'block';
        el.style.transform = `translate(${h.x + 14}px, ${h.y + 14}px)`;
        dot.style.transform = `translate(${h.sx - 4}px, ${h.sy - 4}px)`;
        el.textContent = pathTipText(h.tMs, launch ? liftoffMsOf(launch) : null);
      },
      onPathSeek: (h) => jumpToSimTime(h.tMs),
      onPathLabels: showPathLabels,
      onLabels: (labels, n) => objectLayer.update(labels, n),
      onFollowChange: (f) => store.getState().setFollow(f),
      onSurfaceChange: (on) => useView.getState().setSurface(on),
      onSurfacePrefChange: (on) => useView.getState().setSurfaceAuto(on),
      onFirstPersonChange: (id) => {
        useView.getState().setFirstPerson(id);
        if (id === null) useView.getState().skyDispatch({ type: 'fpEnded' }); // however it ended: a sky view over it ends too
      },
    });
    scene.current = ctl;
    runtime.onFitRequest = (ids) => ctl.fitEntities(ids);
    const camera: CameraCommands = {
      fitSelected: () => {
        const s = store.getState();
        const rec = s.selectedId ? s.entities.get(s.selectedId) : undefined;
        if (!rec) return;
        const rel = relatedFor(rec, { entities: s.entities, launches: s.launches, dsn: s.dsn });
        ctl.fitEntities(rel.ids, { points: rel.points });
      },
      fitVisible: () => ctl.fitVisible(),
      toggleSurface: () => ctl.toggleSurface(),
      viewCloseUp: (id) => { ctl.viewCloseUp(id); },
      lookFrom: (id) => ctl.lookFrom(id),
      leaveFirstPerson: () => ctl.leaveFirstPerson(),
      firstPersonPose: () => ctl.firstPersonPose(),
      setFirstPersonLook: (dir, vFov) => ctl.setFirstPersonLook(dir, vFov),
      setPaused: (on) => ctl.setPaused(on),
      setFirstPersonHold: (on) => ctl.setFirstPersonHold(on),
    };
    runtime.camera = camera;
    if (import.meta.env.DEV) (window as unknown as { __eio?: unknown }).__eio = { ctl, store, runtime, clock, view: useView };
    const s0 = store.getState();
    // display settings (View menu, Settings): apply the remembered ones now, then every change
    const v0 = useView.getState();
    ctl.setDetailEnabled(v0.detail);
    ctl.setLabelsEnabled(v0.labels);
    ctl.setSunShading(v0.sunShading);
    ctl.setMinorPlanets(v0.minorPlanets, () => api);
    ctl.setScopeMode(v0.scopeAll ? 'all' : 'auto');
    ctl.setSurfaceAuto(v0.surfaceAuto);
    ctl.setSmoothCamera(v0.smoothCamera);
    const unsubView = useView.subscribe((v, p) => {
      if (v.detail !== p.detail) ctl.setDetailEnabled(v.detail);
      if (v.labels !== p.labels) ctl.setLabelsEnabled(v.labels);
      if (v.sunShading !== p.sunShading) ctl.setSunShading(v.sunShading);
      if (v.minorPlanets !== p.minorPlanets) ctl.setMinorPlanets(v.minorPlanets, () => api);
      if (v.scopeAll !== p.scopeAll) ctl.setScopeMode(v.scopeAll ? 'all' : 'auto');
      if (v.surfaceAuto !== p.surfaceAuto) ctl.setSurfaceAuto(v.surfaceAuto);
      if (v.smoothCamera !== p.smoothCamera) ctl.setSmoothCamera(v.smoothCamera);
    });
    const unsubSkin = useSkin.subscribe((s, p) => { if (s.skin !== p.skin) ctl.refreshPalette(); });
    ctl.setEntities(s0.entities);
    ctl.setLaunches(s0.launches);
    // the query, the selection with the objects related to it (never hidden, filtered out nor scoped out; same lookup FIT
    // uses) and HIGHLIGHT reach the scene together
    const syncView = (s: ReturnType<typeof store.getState>) => {
      const rec = s.selectedId ? s.entities.get(s.selectedId) : undefined;
      ctl.setView({
        query: s.query, text: s.textIds, selectedId: s.selectedId, highlight: s.highlight,
        related: rec ? relatedFor(rec, { entities: s.entities, launches: s.launches, dsn: s.dsn }).ids : [],
      });
    };
    syncView(s0);
    ctl.setFrame(s0.frame, s0.frameLocked);
    // a camera request made before this controller existed (the frame restored from storage when the catalog was already there,
    // a remount): the new controller starts at the home view, so replay it and then the follow flag the store holds
    if (s0.focus) ctl.focus(s0.focus);
    ctl.setFollow(s0.follow);
    const unsub = store.subscribe((s, p) => {
      if (s.entities !== p.entities) {
        // a merge that started from the catalogue the scene already has costs only its records (SceneController.applyEntityDelta)
        if (s.entityChange && s.entityChange.base === p.entities) ctl.applyEntityDelta(s.entityChange.records);
        else ctl.setEntities(s.entities);
      }
      if (s.launches !== p.launches) ctl.setLaunches(s.launches);
      if (
        s.query !== p.query || s.textIds !== p.textIds || s.highlight !== p.highlight || s.selectedId !== p.selectedId
        || s.entities !== p.entities || s.launches !== p.launches || s.dsn !== p.dsn
      ) syncView(s);
      if (s.frame !== p.frame || s.frameLocked !== p.frameLocked) ctl.setFrame(s.frame, s.frameLocked);
      if (s.follow !== p.follow) ctl.setFollow(s.follow);
      if (s.focus !== p.focus && s.focus) ctl.focus(s.focus);
      if (s.iss.fix !== p.iss.fix) ctl.setIssFix(s.iss.fix);
      if (s.iss.arrays !== p.iss.arrays) ctl.setIssArrays(s.iss.arrays);
    });
    const timer = setInterval(() => setStats(ctl.getStats()), 500);
    return () => {
      clearInterval(timer);
      unsub();
      unsubView();
      unsubSkin();
      if (runtime.onFitRequest) runtime.onFitRequest = undefined;
      if (runtime.camera === camera) runtime.camera = undefined; // StrictMode remounts: only clear our own
      ctl.dispose();
      useView.getState().setFirstPerson(null);
      useView.getState().skyDispatch({ type: 'reset' }); // the scene is gone (unmount, hot reload): no sky view of it is left in any phase
      pathLayer.dispose();
      objectLayer.dispose();
      scene.current = null;
    };
  }, []);

  // hotkeys: F fit, Shift+F fit visible, S surface view, H help (not while typing, not with Ctrl/Alt/Meta)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey || isTyping(e)) return;
      // the sky view covers the scene: its hotkeys (and the help they open) would act on something that cannot be seen
      if (e.key !== 'Escape' && skyCoversScene(useView.getState().sky.phase)) return;
      const k = e.key.toLowerCase();
      if (k === 'f') {
        e.preventDefault();
        if (e.shiftKey || !useStore.getState().selectedId) runtime.camera?.fitVisible();
        else runtime.camera?.fitSelected();
      } else if (k === 's' && !e.shiftKey) {
        e.preventDefault();
        runtime.camera?.toggleSurface();
      } else if (k === 'h' || e.key === '?') useView.getState().toggleHelp();
      else if (e.key === 'Escape') useView.getState().setHelp(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const path = stats?.path;
  const fromFrame = stats && (!stats.frame.isDefault || stats.frame.locked) ? ` from ${stats.frame.label}` : '';
  return (
    <div className="scene" data-sky={skyPhase}>
      <div ref={host} className="scene-host" />
      <div ref={labelHost} className="path-labels" />
      <SkyOverlay annotations={<SkyMarkers />} />
      <SkyArchive />
      <div ref={tip} className="scene-tip" />
      <div ref={pathTip} className="scene-tip" />
      <div ref={pathDot} className="path-dot" />
      {pick && <PickPopup items={pick.items} more={pick.more} x={pick.x} y={pick.y} onSelect={choosePick} onClose={closePick} onHighlight={highlightPick} />}
      {/* top left: where you are (frame of reference). Top right: the camera. Display settings live in the View menu (top bar),
          the selection's own camera actions (follow, fit, model) in the selection panel. */}
      <div className="scene-top">
        <FrameBar />
      </div>
      <div className="scene-tools" role="toolbar" aria-label="Camera">
        {skyCovered && (
          <button className="key on" onClick={leaveSkyView}
            title="Back to the Earth view: leaves the sky view and the first-person view in one step, the observatory stays selected (Esc)">
            Back<kbd>Esc</kbd>
          </button>
        )}
        {firstPerson && !skyCovered && (
          <button className="key on" onClick={() => runtime.camera?.leaveFirstPerson()}
            title="Leave the first-person view: back to the Earth view you had, the observatory stays selected (Esc)">
            Leave<kbd>Esc</kbd>
          </button>
        )}
        {!skyCovered && <button className={surface ? 'key on' : 'key'} onClick={() => runtime.camera?.toggleSurface()} aria-pressed={surface}
          title="Surface-aligned camera: centred on the selected object, level horizon, north-up. On by default near the Earth; turn it off for the globe view, the choice is remembered (S)">
          Surface<kbd>S</kbd>
        </button>}
        {!skyCovered && <button className="key" onClick={() => runtime.camera?.fitVisible()} title="Frame everything currently visible, respecting the search and the hidden groups (Shift+F)">
          Fit all<kbd>⇧F</kbd>
        </button>}
        <button className={help ? 'key on' : 'key'} onClick={() => useView.getState().toggleHelp()} aria-pressed={help} aria-label="Scene controls" title="Scene controls (H)">?</button>
      </div>
      {help && (
        <div className="popover scene-help" role="dialog" aria-label="Scene controls">
          <div className="pop-title">Scene controls</div>
          <div className="help-scroll">
            {HELP.map(([key, text]) => (
              <div key={key} className="help-row"><kbd>{key}</kbd><span>{text}</span></div>
            ))}
          </div>
        </div>
      )}
      <div className="scene-foot">
        {showLegend && (
          <div className="scene-legend" aria-label="Colour legend">
            {LEGEND.map(([k, label]) => (
              <span key={k}><i style={{ background: `var(--c-${k})` }} />{label}</span>
            ))}
          </div>
        )}
        <div className="scene-hud mono">
          {stats && (
            <>
              {stats.firstPerson ? (
                <span className="lit" title="First-person view: the camera stands at the observatory. Drag turns the view, the wheel changes the field of view">
                  {firstPersonReadout(stats.firstPerson.name, stats.firstPerson.az, stats.firstPerson.el, stats.firstPerson.fovDeg)}
                </span>
              ) : (
                <span>Camera {fmtDist(stats.distKm)}{fromFrame}{stats.frame.locked ? ' (locked)' : ''}</span>
              )}
              <span
                style={{ minWidth: '22ch' }}
                title={'Objects drawn (in scope, not filtered out, in view, not behind the Earth) out of all with a position. In scope: the objects of the system the camera is in and of the bodies above it (' + scopeLabel(stats.scope.focus, stats.scope.mode) + '); View > Draw everything turns this off'}
              >
                {stats.scope.rendered.toLocaleString('en-US')} of {stats.scope.total.toLocaleString('en-US')} drawn · {scopeLabel(stats.scope.focus, stats.scope.mode)}
              </span>
              <span title="Satellites propagated with SGP4 in the worker, plus objects propagated on the main thread">
                {stats.satCount.toLocaleString('en-US')} SGP4, {stats.dynCount} other
              </span>
              <span style={{ minWidth: '6ch' }}>{Math.round(stats.fps)} fps</span>
              {stats.detail && (
                <span className="lit" title="Streamed close-up imagery over the base map: tile level (0.6 km per pixel at 6) and tiles received of the 4 x 4 window. Missing tiles show the base map.">
                  Close-up z{stats.detail.z} {stats.detail.ready}/{stats.detail.total}
                </span>
              )}
              {stats.surface && <span className="lit">Surface view, altitude {fmtDist(stats.altKm)}</span>}
              {stats.models.length > 0 && (
                <span className="lit" title="3D model drawn at true size (the point sprite is replaced once the model is larger than it)">
                  Model {stats.models.map((id) => modelDef(useStore.getState().entities.get(id)?.render?.model)?.label ?? id).join(', ')}
                  {stats.arrays ? `, arrays ${sourceLabel(stats.arrays.sources)}` : ''}
                </span>
              )}
              {path && <span>Path {fmtPathWindow(path.pastMs, path.futureMs)}</span>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
