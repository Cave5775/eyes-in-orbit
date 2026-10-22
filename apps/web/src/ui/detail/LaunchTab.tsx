import { formatCountdown, type Launch } from '@eio/core';
import { fmtLat, fmtLon, fmtUtc } from '../../lib/format';
import { liveMission, statusTone } from '../../lib/launch';
import { useSimNow } from '../hooks';
import { Field } from './Field';

export function LaunchTab({ launch }: { launch: Launch }) {
  const now = useSimNow(250);
  const m = liveMission(launch, now);
  const net = Date.parse(launch.net);

  return (
    <div>
      <div className="countdown mono">{formatCountdown(net - now)}</div>
      <div className="chips tight">
        <span className={`chip ${statusTone(launch.status.id)}`}>{launch.status.name}</span>
        <span className="chip">{m.phase.replace(/_/g, ' ')}</span>
        {m.hold && <span className="chip warn">HOLD</span>}
        {m.inferred && <span className="chip dim">PHASE INFERRED</span>}
      </div>
      <dl className="kv">
        <Field label="NET" value={`${fmtUtc(net)} UTC`} />
        {launch.windowStart && launch.windowEnd && (
          <Field label="Window" value={`${fmtUtc(Date.parse(launch.windowStart)).slice(11)} - ${fmtUtc(Date.parse(launch.windowEnd)).slice(11)} UTC`} />
        )}
        <Field label="Provider" value={launch.provider} />
        <Field label="Vehicle" value={launch.vehicle} />
        <Field label="Mission" value={launch.mission?.name} />
        <Field label="Type" value={launch.mission?.type} />
        <Field label="Orbit" value={launch.mission?.orbit} />
        <Field label="Pad" value={launch.pad?.name} />
        <Field label="Site" value={launch.pad?.location} />
        {launch.pad && <Field label="Pad lat/lon" value={`${fmtLat(launch.pad.latitude)}  ${fmtLon(launch.pad.longitude)}`} mono />}
      </dl>
      {launch.mission?.description && <p className="desc">{launch.mission.description}</p>}
    </div>
  );
}
