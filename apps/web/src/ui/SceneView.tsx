import { useCallback, useEffect, useRef, useState } from 'react';
import { fmtDist, fmtDuration } from '../lib/format';
import { relatedFor } from '../lib/related';
import { SceneController, type PathLabel, type SceneStats } from '../scene/SceneController';
import { runtime } from '../state/runtime';
import { useStore } from '../state/store';

const LEGEND: [string, string][] = [
  ['station', 'Station'], ['satellite', 'Satellite'], ['starlink', 'Starlink'], ['debris', 'Debris'],
  ['probe', 'Probe'], ['vehicle', 'Launch'], ['ground', 'Ground'],
];

const HELP: [string, string][] = [
  ['Left drag', 'Orbit (surface view: look around the local horizon)'],
  ['Right / Shift drag', 'Pan (globe view)'],
  ['Wheel / pinch', 'Zoom: step scales with height above the surface'],
  ['Click', 'Select an object; hover for its name'],
  ['F', 'Fit the selection and its related objects'],
  ['Shift+F', 'Fit everything visible (respects filters)'],
  ['S', 'Surface view: level horizon, north-up, around the object\'s sub-point or the point under the view'],
  ['Esc', 'Deselect and return to the Earth view'],
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
    if (import.meta.env.DEV) (window as unknown as { __eio?: unknown }).__eio = { ctl, store, runtime };
    const s0 = store.getState();
    ctl.setFilters(s0.filters);
    ctl.setEntities(s0.entities);
    ctl.setLaunches(s0.launches);
    ctl.setSelected(s0.selectedId);
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
      if (s.selectedId !== p.selectedId || s.entities !== p.entities || s.launches !== p.launches || s.dsn !== p.dsn) syncRelated(s);
      if (s.follow !== p.follow) ctl.setFollow(s.follow);
      if (s.focus !== p.focus && s.focus) ctl.focus(s.focus);
      if (s.iss.fix !== p.iss.fix) ctl.setIssFix(s.iss.fix);
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
      <div className="scene-actions">
        {selectedId && (
          <button className={follow ? 'btn active' : 'btn'} onClick={() => setFollow(!follow)} title="Keep the camera locked on the selected object">
            {follow ? 'FOLLOWING' : 'FOLLOW'}
          </button>
        )}
        {selectedId && (
          <button className="btn" onClick={fitSelected} title="Frame the selection and its related objects (F)">FIT</button>
        )}
        <button className="btn" onClick={fitVisible} title="Frame everything currently visible, respecting filters (Shift+F)">FIT VISIBLE</button>
        <button className={surface ? 'btn active' : 'btn'} onClick={toggleSurface} aria-pressed={surface} title="Surface-aligned camera: level horizon, north-up, around the selection's sub-point or the point under the view (S)">
          SURFACE
        </button>
        <button className="btn" onClick={resetView} title="Deselect and return to the Earth view (Esc)">EARTH VIEW</button>
        <button className={scopeAll ? 'btn active' : 'btn'} onClick={toggleScope} aria-pressed={scopeAll} title="Scope: AUTO draws only what is relevant to the camera focus (nearby objects, the selection and what is related to it, everything a filter lets through); ALL draws everything the filters allow">
          SCOPE {scopeAll ? 'ALL' : 'AUTO'}
        </button>
        <button className={help ? 'btn icon active' : 'btn icon'} onClick={() => setHelp((v) => !v)} aria-pressed={help} title="Controls (H)">?</button>
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
            <span>CAM {fmtDist(stats.distKm)}</span>
            <span>{stats.satCount.toLocaleString('en-US')} SGP4 + {stats.dynCount} PROP</span>            <span>EARTH {stats.earth === 'texture' ? 'TEXTURE' : 'PROCEDURAL'}</span>
            <span>{Math.round(stats.fps)} FPS</span>
            <span style={{ minWidth: '24ch' }} title="Objects drawn (in scope, not filtered out, in view, not behind the Earth) out of all with a position">
              RENDERED {stats.scope.rendered.toLocaleString('en-US')} / {stats.scope.total.toLocaleString('en-US')}
            </span>
            {stats.surface && <span className="accent">SURFACE VIEW ALT {fmtDist(stats.altKm)}</span>}
            {path && (
              <span>PATH -{fmtDuration(-path.pastMs / 1000)} / +{fmtDuration(path.futureMs / 1000)}</span>
            )}
            {(stats.shellSelected || path?.compressed) && (
              <span className="warn">DISTANCE NOT TO SCALE: {stats.shellSelected ? (path?.compressed ? 'SELECTION AND PATH' : 'SELECTION') : 'PATH'} ON COMPRESSED SHELL</span>
            )}
          </>
        )}
      </div>
    </div>
  );
}
