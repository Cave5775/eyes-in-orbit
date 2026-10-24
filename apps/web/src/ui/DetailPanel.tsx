import { useEffect, useMemo, useState } from 'react';
import { kindLabel, launchOf } from '../lib/entity';
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
  const select = useStore((s) => s.select);
  const frame = useStore((s) => s.frame);
  const frameLocked = useStore((s) => s.frameLocked);
  const setFrame = useStore((s) => s.setFrame);
  const setFrameLocked = useStore((s) => s.setFrameLocked);
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
        <div className="panel-head"><span>DETAIL</span></div>
        <div className="empty big">Select an object on the globe, in the entity list, the launch board or the DSN panel.</div>
      </aside>
    );
  }

  return (
    <aside className="panel right">
      <div className="panel-head">
        <span className="detail-name" title={rec.name}>{rec.name}</span>
        <button className="btn icon" onClick={() => select(null)} aria-label="Clear selection" title="Clear selection">&times;</button>
      </div>
      <div className="detail-sub">
        <span className="chip">{kindLabel(rec.kind)}</span>
        {rec.group && <span className="chip alt">{rec.group}</span>}
        <span className="mono dim">{rec.id}</span>
      </div>
      {/* LOCK FRAME: this object becomes the frame of reference and stays it while other objects are selected */}
      {frame.kind === 'entity' && frame.id === rec.id && frameLocked ? (
        <button
          className="btn frame-action on" onClick={() => setFrameLocked(false)}
          title={`The frame of reference is locked on ${rec.name}: selecting other objects does not change it. Unlock to let the Earth, Moon and Sun views take it over again; the frame stays on this object until you pick another in the FRAME bar.`}>
          UNLOCK FRAME
        </button>
      ) : (
        <button
          className="btn frame-action" onClick={() => setFrame({ kind: 'entity', id: rec.id }, { lock: true, fly: true })}
          title={`Make ${rec.name} the frame of reference and lock it: orbit lines, trails, paths and range / speed readouts of every object you select next are relative to it. Selecting other objects does not change the frame.`}>
          LOCK FRAME TO THIS OBJECT
        </button>
      )}
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
