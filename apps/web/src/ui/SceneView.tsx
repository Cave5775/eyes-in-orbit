import { useCallback, useEffect, useRef, useState } from 'react';
import { sourceLabel } from '../lib/arrays';
import { fmtDist, fmtPathWindow } from '../lib/format';
import { colorKeyOf, kindLabel } from '../lib/entity';
import { relatedFor } from '../lib/related';
import { modelDef } from '../scene/models/registry';
import { SceneController, type PathLabel, type SceneStats } from '../scene/SceneController';
import { clock, runtime } from '../state/runtime';
import { useStore } from '../state/store';
import { FrameBar } from './FrameBar';
import { PickPopup, type PickItem } from './PickPopup';

const LEGEND: [string, string][] = [
  ['station', 'Station'], ['satellite', 'Satellite'], ['starlink', 'Starlink'], ['debris', 'Debris'],
  ['probe', 'Probe'], ['vehicle', 'Launch'], ['ground', 'Ground'],
];

const HELP: [string, string][] = [
  ['Left drag', 'Orbit (surface view: look around the local horizon)'],
  ['Right / Shift drag', 'Pan (surface view: lets go of the followed object and slides along the ground at its height)'],
  ['Wheel / pinch', 'Zoom: step scales with height above the surface'],
  ['Click', 'Select an object; hover for its name. Where several overlap a list opens: wheel or arrows choose, click or Enter selects, Esc closes'],
  ['F', 'Fit the selection and its related objects'],
  ['Shift+F', 'Fit everything visible (respects filters)'],
  ['S', 'Surface view: the camera is centred on the selected object but oriented to the local surface (level horizon, north-up). On by default for objects near the Earth (orbit, launch, booster, ground); S or SURFACE switches to the globe view, and that choice is remembered until you press S again'],
  ['Esc', 'Deselect and return to the Earth view'],
  ['MODEL', 'Objects with a 3D model (ISS, launch boosters, one Starlink) turn from a point into the true-size model once the camera is within its distance (ISS 45 km, booster 12 km, satellite 6 km; the point stays until the model is bigger than it). F or MODEL on such a selection flies to it'],
  ['PANELS (top bar)', 'Show or hide the DSN panel (hidden by default), the launch board and the news ticker; the space is given back to the globe and the choice is remembered'],
  ['H', 'Show / hide this help'],
];

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || t.isContentEditable);
}

export function SceneView() {
  const host = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const labelHost = useRef<HTMLDivElement>(null);
  const scene = useRef<SceneController | null>(null);
  const [stats, setStats] = useState<SceneStats | null>(null);
  const [surface, setSurface] = useState(false);
  const [help, setHelp] = useState(false);
  const [scopeAll, setScopeAll] = useState(false);
  const [trueScale, setTrueScale] = useState(false);
  /** open choice popup for a click on overlapping objects */
  const [pick, setPick] = useState<{ items: PickItem[]; more: number; x: number; y: number } | null>(null);
  const closePick = useCallback(() => setPick(null), []);
  const choosePick = useCallback((id: string) => {
    setPick(null);
    useStore.getState().select(id);
  }, []);
  const highlightPick = useCallback((id: string | null) => scene.current?.setPreview(id), []);
  const selectedId = useStore((s) => s.selectedId);
  const follow = useStore((s) => s.follow);
  const resetView = useStore((s) => s.resetView);
  const setFollow = useStore((s) => s.setFollow);

  /** FIT: the selection plus related objects (parent/children, pad, linked probes or stations) and its drawn path. */
  const fitSelected = useCallback(() => {
    const s = useStore.getState();
    const rec = s.selectedId ? s.entities.get(s.selectedId) : undefined;
    if (!rec) return;
    const rel = relatedFor(rec, { entities: s.entities, launches: s.launches, dsn: s.dsn });
    scene.current?.fitEntities(rel.ids, { points: rel.points });
  }, []);
  const fitVisible = useCallback(() => {
    scene.current?.fitVisible();
  }, []);
  const toggleSurface = useCallback(() => scene.current?.toggleSurface(), []);
  // the popup describes where objects were under the cursor: any selection change (a list click, the browser, a hotkey) retires it
  useEffect(() => setPick(null), [selectedId]);
  const selModel = useStore((s) => modelDef(s.selectedId ? s.entities.get(s.selectedId)?.render?.model : undefined));
  const showModel = useCallback(() => {
    const id = useStore.getState().selectedId;
    if (id) scene.current?.viewModel(id);
  }, []);
  const toggleScale = useCallback(() => {
    setTrueScale((v) => {
      scene.current?.setDistanceScale(v ? 'compressed' : 'true');
      return !v;
    });
  }, []);
  // streamed close-up imagery is on unless the user turned it off (remembered per browser)
  const [detailOn, setDetailOn] = useState(() => {
    try {
      return localStorage.getItem('eio.detail') !== 'off';
    } catch {
      return true;
    }
  });
  const toggleDetail = useCallback(() => {
    setDetailOn((v) => {
      try {
        localStorage.setItem('eio.detail', v ? 'off' : 'on');
      } catch { /* private window: the choice just is not remembered */ }
      scene.current?.setDetailEnabled(!v);
      return !v;
    });
  }, []);
  const toggleScope = useCallback(() => {
    setScopeAll((v) => {
      scene.current?.setScopeMode(v ? 'auto' : 'all');
      return !v;
    });
  }, []);

  useEffect(() => {
    const store = useStore;
    const labelEls: HTMLDivElement[] = [];
    const showLabels = (labels: PathLabel[]) => {
      const root = labelHost.current;
      if (!root) return;
      while (labelEls.length < labels.length) {
        const el = document.createElement('div');
        el.className = 'path-label mono';
        root.appendChild(el);
        labelEls.push(el);
      }
      labelEls.forEach((el, i) => {
        const l = labels[i];
        if (!l) {
          el.style.display = 'none';
          return;
        }
        el.style.display = 'block';
        el.style.transform = `translate(${Math.round(l.x + 8)}px, ${Math.round(l.y - 9)}px)`;
        if (el.textContent !== l.text) el.textContent = l.text;
      });
    };
    const ctl = new SceneController(host.current!, {
      onPick: (id) => store.getState().select(id),
      onPickMany: (ids, total, x, y) => {
        const ents = store.getState().entities;
        const items: PickItem[] = [];
        for (const id of ids) {
          const rec = ents.get(id);
          if (rec) items.push({ id, name: rec.name, kind: kindLabel(rec.kind), colorKey: colorKeyOf(rec) });
        }
        if (items.length === 1) store.getState().select(items[0].id);
        else if (items.length > 1) setPick({ items, more: total - items.length, x, y });
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
        el.textContent = `${rec.name}  ·  ${rec.kind.replace(/_/g, ' ')}`;
      },
      onPathLabels: showLabels,
      onFollowChange: (f) => store.getState().setFollow(f),
      onSurfaceChange: setSurface,
    });
    scene.current = ctl;
    runtime.onFitRequest = (ids) => ctl.fitEntities(ids);
    if (import.meta.env.DEV) (window as unknown as { __eio?: unknown }).__eio = { ctl, store, runtime, clock };
    const s0 = store.getState();
    try {
      ctl.setDetailEnabled(localStorage.getItem('eio.detail') !== 'off');
    } catch { /* storage blocked: detail stays on */ }
    ctl.setFilters(s0.filters);
    ctl.setEntities(s0.entities);
    ctl.setLaunches(s0.launches);
    ctl.setSelected(s0.selectedId);
    ctl.setFrame(s0.frame, s0.frameLocked);
    // objects related to the selection are never scoped out (same lookup FIT uses)
    const syncRelated = (s: ReturnType<typeof store.getState>) => {
      const rec = s.selectedId ? s.entities.get(s.selectedId) : undefined;
      ctl.setRelated(rec ? relatedFor(rec, { entities: s.entities, launches: s.launches, dsn: s.dsn }).ids : []);
    };
    syncRelated(s0);
    const unsub = store.subscribe((s, p) => {
      if (s.entities !== p.entities) ctl.setEntities(s.entities);
      if (s.filters !== p.filters) ctl.setFilters(s.filters);
      if (s.launches !== p.launches) ctl.setLaunches(s.launches);
      if (s.selectedId !== p.selectedId) ctl.setSelected(s.selectedId);
      if (s.frame !== p.frame || s.frameLocked !== p.frameLocked) ctl.setFrame(s.frame, s.frameLocked);
      if (s.selectedId !== p.selectedId || s.entities !== p.entities || s.launches !== p.launches || s.dsn !== p.dsn) syncRelated(s);
      if (s.follow !== p.follow) ctl.setFollow(s.follow);
      if (s.focus !== p.focus && s.focus) ctl.focus(s.focus);
      if (s.iss.fix !== p.iss.fix) ctl.setIssFix(s.iss.fix);
      if (s.iss.arrays !== p.iss.arrays) ctl.setIssArrays(s.iss.arrays);
    });
    const timer = setInterval(() => setStats(ctl.getStats()), 500);
    return () => {
      clearInterval(timer);
      unsub();
      if (runtime.onFitRequest) runtime.onFitRequest = undefined;
      ctl.dispose();
      scene.current = null;
    };
  }, []);

  // hotkeys: F fit, Shift+F fit visible, S surface view, H help (not while typing, not with Ctrl/Alt/Meta)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey || isTyping(e)) return;
      const k = e.key.toLowerCase();
      if (k === 'f') {
        e.preventDefault();
        if (e.shiftKey || !useStore.getState().selectedId) fitVisible();
        else fitSelected();
      } else if (k === 's' && !e.shiftKey) {
        e.preventDefault();
        toggleSurface();
      } else if (k === 'h' || e.key === '?') setHelp((v) => !v);
      else if (e.key === 'Escape') setHelp(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fitSelected, fitVisible, toggleSurface]);

  const path = stats?.path;
  return (
    <div className="scene">
      <div ref={host} className="scene-host" />
      <div ref={labelHost} className="path-labels" />
      <div ref={tip} className="scene-tip" />
      {pick && <PickPopup items={pick.items} more={pick.more} x={pick.x} y={pick.y} onSelect={choosePick} onClose={closePick} onHighlight={highlightPick} />}
      <div className="scene-top">
      <div className="scene-actions">
        {selectedId && (
          <button className={follow ? 'btn active' : 'btn'} onClick={() => setFollow(!follow)} title="Keep the camera locked on the selected object">
            {follow ? 'FOLLOWING' : 'FOLLOW'}
          </button>
        )}
        {selectedId && (
          <button className="btn" onClick={fitSelected} title="Frame the selection and its related objects (F)">FIT</button>
        )}
        {selModel && (
          <button className="btn" onClick={showModel} title={`Fly to the 3D model (${selModel.label}) and follow it. It replaces the point sprite within ${selModel.lodKm} km.`}>MODEL</button>
        )}
        <button className="btn" onClick={fitVisible} title="Frame everything currently visible, respecting filters (Shift+F)">FIT VISIBLE</button>
        <button className={surface ? 'btn active' : 'btn'} onClick={toggleSurface} aria-pressed={surface} title="Surface-aligned camera: centred on the selected object, level horizon, north-up. On by default near the Earth; turn it off for the globe view, the choice is remembered (S)">
          SURFACE
        </button>
        <button className="btn" onClick={resetView} title="Deselect and return to the Earth view (Esc)">EARTH VIEW</button>
        <button className={scopeAll ? 'btn active' : 'btn'} onClick={toggleScope} aria-pressed={scopeAll} title="Scope: AUTO draws only what is relevant to the camera focus (nearby objects, the selection and what is related to it, everything a filter lets through); ALL draws everything the filters allow">
          SCOPE {scopeAll ? 'ALL' : 'AUTO'}
        </button>
        <button className={detailOn ? 'btn active' : 'btn'} onClick={toggleDetail} aria-pressed={detailOn} title="Close-up detail: below about 2,600 km, finer Earth imagery (NASA Blue Marble, up to 0.6 km per pixel) is streamed through the local server and laid over the base map. Off keeps the base map only.">
          DETAIL
        </button>
        <button className={help ? 'btn icon active' : 'btn icon'} onClick={() => setHelp((v) => !v)} aria-pressed={help} title="Controls (H)">?</button>
      </div>
      <FrameBar />
      </div>
      {help && (
        <div className="popover scene-help" role="dialog" aria-label="Scene controls">
          <div className="pop-title">SCENE CONTROLS</div>
          {HELP.map(([key, text]) => (
            <div key={key} className="help-row"><kbd>{key}</kbd><span>{text}</span></div>
          ))}
        </div>
      )}
      <div className="scene-legend">
        {LEGEND.map(([k, label]) => (
          <span key={k}><i style={{ background: `var(--c-${k})` }} />{label}</span>
        ))}
      </div>
      <div className="scene-hud mono">
        {stats && (
          <>
            <span>CAM {fmtDist(stats.distKm)}{!stats.frame.isDefault || stats.frame.locked ? ` FROM ${stats.frame.label.toUpperCase()}` : ''}{stats.frame.locked ? ' [LOCKED]' : ''}</span>
            <span>{stats.satCount.toLocaleString('en-US')} SGP4 + {stats.dynCount} PROP</span>            <span title={`Earth map width in pixels (GPU texture limit ${stats.maxTexturePx}). Run npm run assets and reload the page for the high-resolution map.`}>EARTH {stats.earth === 'texture' ? `TEXTURE ${stats.earthPx}` : 'PROCEDURAL'}</span>
            {stats.detail && (
              <span className="accent" title="Streamed close-up imagery over the base map: tile level (0.6 km per pixel at 6) and tiles received of the 4 x 4 window. Missing tiles show the base map.">
                DETAIL Z{stats.detail.z} {stats.detail.ready}/{stats.detail.total}
              </span>
            )}
            <span>{Math.round(stats.fps)} FPS</span>
            <span style={{ minWidth: '24ch' }} title="Objects drawn (in scope, not filtered out, in view, not behind the Earth) out of all with a position">
              RENDERED {stats.scope.rendered.toLocaleString('en-US')} / {stats.scope.total.toLocaleString('en-US')}
            </span>
            {stats.surface && <span className="accent">SURFACE VIEW ALT {fmtDist(stats.altKm)}</span>}
            {stats.models.length > 0 && (
              <span className="accent" title="3D model drawn at true size (the point sprite is replaced once the model is larger than it)">
                MODEL {stats.models.map((id) => modelDef(useStore.getState().entities.get(id)?.render?.model)?.key.toUpperCase() ?? id).join(', ')}
                {stats.arrays ? ` · ARRAYS ${sourceLabel(stats.arrays.sources)}` : ''}
              </span>
            )}
            {path && (
              <span>PATH {fmtPathWindow(path.pastMs, path.futureMs)}</span>
            )}
            {(stats.shellSelected || path?.compressed) && (
              <span className="warn">DISTANCE NOT TO SCALE: {stats.shellSelected ? (path?.compressed ? 'SELECTION AND PATH' : 'SELECTION') : 'PATH'} ON COMPRESSED SHELL</span>
            )}
            <button
              className={trueScale ? 'hud-toggle on' : 'hud-toggle'}
              onClick={toggleScale}
              aria-pressed={trueScale}
              title={trueScale ? 'Probes are drawn at their real distance from Earth (up to ~2.5e10 km). Click to go back to the compressed deep-space shell.' : 'Objects beyond 2,000,000 km are drawn on a log-compressed shell. Click to draw probes at their real distance (true scale).'}
            >
              DISTANCE: {trueScale ? 'TRUE SCALE' : 'COMPRESSED'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
