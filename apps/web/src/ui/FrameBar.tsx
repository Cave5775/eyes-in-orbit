import { useEffect, useState } from 'react';
import { isOrbitableBody } from '../lib/frame';
import { clock, ensureInGraph, graph } from '../state/runtime';
import { useFrameInfo, useStore } from '../state/store';

/**
 * Frame of reference in the scene: the breadcrumb `SUN > EARTH > MOON > LRO` (root first), a click on a crumb makes it the
 * frame and flies there, and the lock toggle keeps the frame while other objects are selected (docs/frames.md).
 */
export function FrameBar() {
  const frame = useFrameInfo();
  const setFrame = useStore((s) => s.setFrame);
  const setFrameLocked = useStore((s) => s.setFrameLocked);
  const centreId = frame.centre.kind === 'entity' ? frame.centre.id : null;
  const centreRec = useStore((s) => (centreId ? s.entities.get(centreId) : undefined));
  const noState = useCentreWithoutState(centreId);

  const last = frame.crumbs.length - 1;
  return (
    <div className={frame.locked ? 'frame-bar locked' : 'frame-bar'} role="navigation" aria-label="Frame of reference">
      <span className="frame-label" title="Frame of reference: orbit lines, trails, paths and range / speed readouts are relative to this centre">FRAME</span>
      <ol className="frame-crumbs">
        {frame.crumbs.map((c, i) => {
          const body = c.centre.kind === 'body';
          const usable = body ? isOrbitableBody(c.centre.id) : !!centreRec;
          return (
            <li key={`${c.centre.kind}:${c.centre.id}`}>
              {i > 0 && <span className="frame-sep" aria-hidden="true">&gt;</span>}
              <button
                className={i === last ? 'frame-crumb cur' : 'frame-crumb'} disabled={!usable} aria-current={i === last ? 'location' : undefined}
                onClick={() => setFrame(c.centre, { fly: true })}
                title={usable ? `Make ${c.label} the frame of reference and fly there` : `${c.label} has no display yet: it cannot be the frame of reference`}>
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
        <span className="frame-hint" role="status" title={`${frame.label} has no state at the simulation time (outside its data range), so paths and orbit lines relative to it cannot be drawn. Move the time, or pick another frame.`}>
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
