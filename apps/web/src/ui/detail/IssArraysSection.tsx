import { ISS_CHANNELS, sunDirectionEci, type EntityRecord } from '@eio/core';
import { CHANNEL_SITE, arrayReadout, arraySources, sourceLabel, sunInBodyFromState, type ArraySource } from '../../lib/arrays';
import { fmtAgo, fmtDeg } from '../../lib/format';
import { graph } from '../../state/runtime';
import { useStore } from '../../state/store';
import { Field } from './Field';

const SOURCE_TONE: Record<ArraySource, string> = { LIVE: 'ok', COMPUTED: '', STATIC: 'warn' };
const SOURCE_HELP: Record<ArraySource, string> = {
  LIVE: 'Values from the ISSLIVE telemetry feed (fresh, at live time) drive the model.',
  COMPUTED: 'No usable live value: the joints are computed so the arrays face the Sun, from the ISS state and the Sun direction.',
  STATIC: 'No ISS state to compute from: the joints rest at zero.',
};

/**
 * Solar array pose of the ISS: where the SARJ (one per side) and the eight BGAs are, and what drives the 3D model:
 * the live feed (LIVE), a sun-tracking pose computed from the Sun direction (COMPUTED) or nothing (STATIC).
 */
export function IssArraysSection({ rec, now, wall }: { rec: EntityRecord; now: number; wall: number }) {
  const arrays = useStore((s) => s.iss.arrays);
  const clockMode = useStore((s) => s.clock.mode);
  const st = graph.stateIn(rec.id, now, 'EARTH:inertial');
  const sources = arraySources(arrays, { liveClock: clockMode === 'live', nowMs: wall, haveState: !!st?.v });
  const sunBody = st?.v ? sunInBodyFromState(st.r, st.v, sunDirectionEci(now), sources.attitude ? arrays?.attitude : undefined) : null;
  const r = arrayReadout(arrays, sunBody, sources, arrays?.sarj);
  const label = sourceLabel(sources);
  const tone = SOURCE_TONE[sources.sarj === sources.bga ? sources.sarj : 'COMPUTED'];
  const feed = arrays ? `feed sample ${fmtAgo(arrays.t, wall)}` : 'no feed data';

  return (
    <>
      <div className="section-title">Arrays</div>
      <div className="chips tight">
        <span className={`chip ${tone}`} title={`${SOURCE_HELP[sources.sarj]}  BGA: ${SOURCE_HELP[sources.bga]}`}>{label}</span>
        <span className="chip" title="SARJ readings are verified against live data; BGA angles are shown as the feed reports them but are not verified, so the model uses the computed tilt">
          SARJ verified · BGA unverified
        </span>
      </div>
      <dl className="kv">
        <Field label="SARJ port" value={r.sarj.port !== undefined ? fmtDeg(r.sarj.port) : undefined} mono />
        <Field label="SARJ starboard" value={r.sarj.starboard !== undefined ? fmtDeg(r.sarj.starboard) : undefined} mono />
        {ISS_CHANNELS.map((c) => {
          const b = r.bga[c];
          const site = CHANNEL_SITE[c].site;
          return <Field key={c} label={`BGA ${c} (${site})`} value={b ? `${fmtDeg(b.deg)} ${b.computed ? 'computed' : 'feed'}` : undefined} mono />;
        })}
        <Field label="Feed" value={feed} mono />
      </dl>
    </>
  );
}
