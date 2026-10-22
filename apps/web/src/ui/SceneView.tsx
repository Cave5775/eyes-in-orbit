import { useEffect, useRef, useState } from 'react';
import { fmtDist } from '../lib/format';
import { SceneController, type SceneStats } from '../scene/SceneController';
import { useStore } from '../state/store';

const LEGEND: [string, string][] = [
  ['station', 'Station'], ['satellite', 'Satellite'], ['starlink', 'Starlink'], ['debris', 'Debris'],
  ['probe', 'Probe'], ['vehicle', 'Launch'], ['ground', 'Ground'],
];

export function SceneView() {
  const host = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const scene = useRef<SceneController | null>(null);
  const [stats, setStats] = useState<SceneStats | null>(null);
  const selectedId = useStore((s) => s.selectedId);
  const follow = useStore((s) => s.follow);
  const resetView = useStore((s) => s.resetView);
  const setFollow = useStore((s) => s.setFollow);

  useEffect(() => {
    const store = useStore;
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
    });
    scene.current = ctl;
    const s0 = store.getState();
    ctl.setFilters(s0.filters);
    ctl.setEntities(s0.entities);
    ctl.setLaunches(s0.launches);
    ctl.setSelected(s0.selectedId);
    const unsub = store.subscribe((s, p) => {
      if (s.entities !== p.entities) ctl.setEntities(s.entities);
      if (s.filters !== p.filters) ctl.setFilters(s.filters);
      if (s.launches !== p.launches) ctl.setLaunches(s.launches);
      if (s.selectedId !== p.selectedId) ctl.setSelected(s.selectedId);
      if (s.follow !== p.follow) ctl.setFollow(s.follow);
      if (s.focus !== p.focus && s.focus) ctl.focus(s.focus);
      if (s.iss.fix !== p.iss.fix) ctl.setIssFix(s.iss.fix);
    });
    const timer = setInterval(() => setStats(ctl.getStats()), 500);
    return () => {
      clearInterval(timer);
      unsub();
      ctl.dispose();
      scene.current = null;
    };
  }, []);

  return (
    <div className="scene">
      <div ref={host} className="scene-host" />
      <div ref={tip} className="scene-tip" />
      <div className="scene-actions">
        {selectedId && (
          <button className={follow ? 'btn active' : 'btn'} onClick={() => setFollow(!follow)} title="Keep the camera locked on the selected object">
            {follow ? 'FOLLOWING' : 'FOLLOW'}
          </button>
        )}
        <button className="btn" onClick={resetView} title="Deselect and return to the Earth view (Esc)">EARTH VIEW</button>
      </div>
      <div className="scene-legend">
        {LEGEND.map(([k, label]) => (
          <span key={k}><i style={{ background: `var(--c-${k})` }} />{label}</span>
        ))}
      </div>
      <div className="scene-hud mono">
        {stats && (
          <>
            <span>CAM {fmtDist(stats.distKm)}</span>
            <span>{stats.satCount.toLocaleString('en-US')} SGP4 + {stats.dynCount} PROP</span>
            <span>EARTH {stats.earth === 'texture' ? 'TEXTURE' : 'PROCEDURAL'}</span>
            <span>{Math.round(stats.fps)} FPS</span>
            {stats.shellSelected && <span className="warn">SELECTION DRAWN ON COMPRESSED SHELL</span>}
          </>
        )}
      </div>
    </div>
  );
}
