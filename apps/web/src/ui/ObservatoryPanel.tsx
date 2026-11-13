import { useMemo } from 'react';
import { observatoryRows } from '../lib/observatories';
import { canOpenSky } from '../lib/sky-window';
import { runtime } from '../state/runtime';
import { useStore } from '../state/store';
import { useView } from '../state/view';

/**
 * Bottom-row panel listing the observatories (entities with the `observatory` attribute): site type, location, wavebands.
 * A row selects the entity (`selectObject`); "Sky view" opens the floating Aladin window looking from the selected one; "Look from here"
 * puts the main scene camera at it (first-person view, `SceneController.lookFrom`).
 */
export function ObservatoryPanel() {
  const entities = useStore((s) => s.entities);
  const selectedId = useStore((s) => s.selectedId);
  const selectObject = useStore((s) => s.selectObject);
  const openSky = useStore((s) => s.openSky);
  const floats = useStore((s) => s.floats);
  const sky = useStore((s) => s.sky);
  const firstPerson = useView((s) => s.firstPerson);

  const rows = useMemo(() => observatoryRows(entities.values()), [entities]);
  const sel = rows.find((r) => r.id === selectedId);
  const full = !canOpenSky(floats, sky);
  const can = !!sel && sel.imagery && !full;
  const why = !sel ? 'Select an observatory first' : !sel.imagery ? `${sel.name} has no sky imagery` : full ? 'Close a floating window first (4 at most)' : `Open a sky view from ${sel.name}`;

  const here = !!sel && firstPerson === sel.id;
  const whyLook = !sel ? 'Select an observatory first' : here ? `Already looking from ${sel.name} (Esc or Leave to go back)` : `Put the camera at ${sel.name} and look outward: drag turns the view, the wheel zooms (Esc leaves)`;

  return (
    <section className="panel obs">
      <div className="panel-head">
        <span>Observatories</span>
        <button className="key" disabled={!can} onClick={() => sel && openSky(sel.id, `Sky view: ${sel.name}`)} title={why}>Sky view</button>
        <button className={here ? 'key on' : 'key'} disabled={!sel || here} onClick={() => sel && runtime.camera?.lookFrom(sel.id)} title={whyLook}>Look from here</button>
        <span className="mono dim">{rows.length}</span>
      </div>
      {rows.length === 0 ? (
        <div className="empty">No observatories loaded.</div>
      ) : (
        <div className="obs-list" role="listbox" aria-label="Observatories">
          {rows.map((r) => (
            <button
              key={r.id} role="option" aria-selected={r.id === selectedId}
              className={r.id === selectedId ? 'obs-row sel' : 'obs-row'} onClick={() => selectObject(r.id)}
              onDoubleClick={() => r.imagery && openSky(r.id, `Sky view: ${r.name}`)}
              title={r.imagery ? `${r.name}: double-click for the sky view` : `${r.name}: no sky imagery`}>
              <span className="obs-name">{r.name}</span>
              <span className={`chip ${r.meta.site === 'space' ? 'accent' : ''}`}>{r.meta.site}</span>
              <span className="obs-place mono dim">{r.place}</span>
              <span className="obs-bands dim">{r.meta.bands.join(', ')}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
