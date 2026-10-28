import { useEffect, useState } from 'react';
import { clock, ensureInGraph, graph } from '../state/runtime';
import { useFrameInfo, useStore } from '../state/store';

/**
 * Frame of reference in the scene: the breadcrumb `SUN > EARTH > MOON > LRO` (root first, one crumb per entity), a click on a
 * crumb selects that entity (`selectObject`: it becomes the frame when it can be one, and the camera flies there), and the lock
 * toggle keeps the frame while other objects are selected (docs/frames.md).
 */
export function FrameBar() {
  const frame = useFrameInfo();
  const selectObject = useStore((s) => s.selectObject);
  const setFrameLocked = useStore((s) => s.setFrameLocked);
  const entities = useStore((s) => s.entities);
  const noState = useCentreWithoutState(frame.isDefault ? null : frame.centre);

  const last = frame.crumbs.length - 1;
  return (
    <div className={frame.locked ? 'frame-bar locked' : 'frame-bar'} role="navigation" aria-label="Frame of reference">
      <span className="frame-label" title="Frame of reference: trails, paths and range / speed readouts are relative to this centre (orbit lines are always round what the object orbits)">FRAME</span>
      <ol className="frame-crumbs">
        {frame.crumbs.map((c, i) => {
          const usable = entities.has(c.id);
          return (
            <li key={c.id}>
              {i > 0 && <span className="frame-sep" aria-hidden="true">&gt;</span>}
              <button
                className={i === last ? 'frame-crumb cur' : 'frame-crumb'} disabled={!usable} aria-current={i === last ? 'location' : undefined}
                onClick={() => selectObject(c.id)}
                title={usable ? `Select ${c.label} and fly there (it becomes the frame of reference unless the frame is locked)` : `${c.label} is not in the catalog`}>
                {c.label.toUpperCase()}
              </button>
            </li>
          );
        })}
      </ol>
      <button
        className={frame.locked ? 'frame-lock on' : 'frame-lock'} aria-pressed={frame.locked} onClick={() => setFrameLocked(!frame.locked)}
        title={frame.locked
          ? `Locked on ${frame.label}: selecting other objects does not change the frame, so their paths and readouts stay relative to it. Click to unlock.`
          : 'Lock the frame: selecting other objects will not change it, so you can pick objects and see their paths and readouts relative to this centre.'}>
        <svg width="10" height="11" viewBox="0 0 10 11" aria-hidden="true">
          <rect x="1" y="5" width="8" height="5.5" rx="1" fill="currentColor" />
          <path d={frame.locked ? 'M2.8 5V3.4a2.2 2.2 0 0 1 4.4 0V5' : 'M2.8 5V3.4a2.2 2.2 0 0 1 4.2-.9'} fill="none" stroke="currentColor" strokeWidth="1.3" />
        </svg>
        {frame.locked ? 'LOCKED' : 'LOCK'}
      </button>
      {noState && (
        <span className="frame-hint" role="status" title={`${frame.label} has no state at the simulation time (outside its data range), so trails and paths relative to it cannot be drawn. Move the time, or pick another frame.`}>
          NO STATE FOR {frame.label.toUpperCase()} AT THIS TIME: PATHS HIDDEN
        </span>
      )}
    </div>
  );
}

/** Does the entity that is the frame centre lack a state at the sim time (then paths relative to it are not drawn)? */
function useCentreWithoutState(id: string | null): boolean {
  const rec = useStore((s) => (id ? s.entities.get(id) : undefined));
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (!id || !rec) {
      setMissing(false);
      return;
    }
    const check = () => {
      ensureInGraph(rec);
      setMissing(!graph.stateIn(id, clock.now(), 'EARTH:inertial'));
    };
    check();
    const h = setInterval(check, 500);
    return () => clearInterval(h);
  }, [id, rec]);
  return missing;
}
