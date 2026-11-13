import { useEffect, useMemo, useState } from 'react';
import { emptyHint } from '../lib/browser-ui';
import { kindLabel, launchOf } from '../lib/entity';
import { modelDef } from '../scene/models/registry';
import { runtime } from '../state/runtime';
import { useStore } from '../state/store';
import { LaunchTab } from './detail/LaunchTab';
import { NewsTab } from './detail/NewsTab';
import { StreamTab } from './detail/StreamTab';
import { TelemetryTab } from './detail/TelemetryTab';

type TabId = 'telemetry' | 'launch' | 'stream' | 'news';

export function DetailPanel() {
  const selectedId = useStore((s) => s.selectedId);
  const rec = useStore((s) => (s.selectedId ? s.entities.get(s.selectedId) : undefined));
  const launches = useStore((s) => s.launches);
  const selectObject = useStore((s) => s.selectObject);
  const frame = useStore((s) => s.frame);
  const frameLocked = useStore((s) => s.frameLocked);
  const setFrame = useStore((s) => s.setFrame);
  const setFrameLocked = useStore((s) => s.setFrameLocked);
  const follow = useStore((s) => s.follow);
  const setFollow = useStore((s) => s.setFollow);
  const model = modelDef(rec?.render?.model);
  const [tab, setTab] = useState<TabId>('telemetry');

  const launch = useMemo(() => launchOf(rec, launches), [rec, launches]);
  const streams = rec?.links?.streams?.length ? rec.links.streams : launch?.streams ?? [];

  const tabs = useMemo(() => {
    const t: [TabId, string][] = [['telemetry', 'Telemetry']];
    if (launch) t.push(['launch', 'Launch']);
    if (streams.length) t.push(['stream', 'Stream']);
    t.push(['news', 'News']);
    return t;
  }, [launch, streams.length]);

  // fall back when the current tab does not exist for the new selection
  useEffect(() => {
    if (!tabs.some(([id]) => id === tab)) setTab('telemetry');
  }, [tabs, tab]);

  if (!selectedId || !rec) {
    return (
      <aside className="panel right">
        <div className="panel-head"><span>Selection</span></div>
        <div className="empty big">{emptyHint()}</div>
      </aside>
    );
  }
  return (
    <aside className="panel right">
      <div className="panel-head">
        <span className="detail-name" title={rec.name}>{rec.name}</span>
        <button className="btn icon" onClick={() => selectObject(null)} aria-label="Clear selection" title="Clear selection">&times;</button>
      </div>
      <div className="detail-sub">
        <span>{kindLabel(rec.kind)}</span>
        {rec.group && <span>{rec.group}</span>}
        <span className="dim">{rec.id}</span>
      </div>
      {/* the selection's camera actions, and the frame lock: this object becomes the frame of reference and stays it while
          other objects are selected */}
      <div className="sel-actions" role="toolbar" aria-label="Selection">
        <button className={follow ? 'key on' : 'key'} aria-pressed={follow} onClick={() => setFollow(!follow)} title="Keep the camera on the selected object">
          Follow
        </button>
        <button className="key" onClick={() => runtime.camera?.fitSelected()} title="Frame the selection and its related objects (F)">
          Fit<kbd>F</kbd>
        </button>
        {model && (
          <button className="key" onClick={() => runtime.camera?.viewModel(rec.id)} title={`Fly to the 3D model (${model.label}) and follow it. It replaces the point sprite within ${model.lodKm} km.`}>
            Model
          </button>
        )}
        {frameLocked && frame === rec.id ? (
          <button
            className="key on warn" aria-pressed="true" onClick={() => setFrameLocked(false)}
            title={`The frame of reference is locked on ${rec.name}: selecting other objects does not change it. Unlock to let selecting a body take it over again; the frame stays on this object until you select another body.`}>
            Frame locked
          </button>
        ) : (
          <button
            className="key" aria-pressed="false" onClick={() => setFrame(rec.id, true)}
            title={`Make ${rec.name} the frame of reference and lock it: trails, paths and range / speed readouts of every object you select next are relative to it (orbit lines stay round what the object orbits). Selecting other objects does not change the frame.`}>
            Lock frame
          </button>
        )}
      </div>
      <div className="tabs" role="tablist">
        {tabs.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'tab on' : 'tab'} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      <div className="tab-body">
        {tab === 'telemetry' && <TelemetryTab rec={rec} />}
        {tab === 'launch' && launch && <LaunchTab launch={launch} />}
        {tab === 'stream' && <StreamTab key={rec.id} streams={streams} />}
        {tab === 'news' && <NewsTab key={rec.id} entityId={rec.id} />}
      </div>
    </aside>
  );
}
