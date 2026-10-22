import type { EntityRecord } from '@eio/core';
import { isIss } from '../../lib/entity';
import { fmtAgo, fmtBitrate, fmtDist, fmtDuration, fmtLat, fmtLon, fmtNum, humanize } from '../../lib/format';
import { computeTelemetry } from '../../lib/telemetry';
import { ensureInGraph, graph } from '../../state/runtime';
import { useStore } from '../../state/store';
import { useSimNow, useWallNow } from '../hooks';
import { Field } from './Field';

function confidenceLabel(c: number | undefined): { text: string; tone: string } | null {
  if (c === undefined) return null;
  return { text: `${Math.round(c * 100)}%`, tone: c > 0.8 ? 'ok' : c > 0.4 ? 'warn' : 'bad' };
}

export function TelemetryTab({ rec }: { rec: EntityRecord }) {
  const now = useSimNow(250);
  const wall = useWallNow(1000);
  const iss = useStore((s) => s.iss);
  const dsn = useStore((s) => s.dsn);
  ensureInGraph(rec);
  const tel = computeTelemetry(graph, rec, now);
  const conf = confidenceLabel(tel?.confidence);
  const code = rec.aliases.dsn;
  const link = code ? dsn?.links.find((l) => l.spacecraft.includes(code)) : undefined;
  const showIss = isIss(rec);
  const attrs = Object.entries(rec.attrs ?? {}).filter(([, v]) => v !== null && v !== '');

  return (
    <div>
      <div className="section-title">STATE @ SIM TIME</div>
      {!tel ? (
        <div className="empty">No state available at this time (outside the provider's valid range).</div>
      ) : (
        <dl className="kv">
          {tel.latDeg !== undefined && <Field label="Latitude" value={fmtLat(tel.latDeg)} mono />}
          {tel.lonDeg !== undefined && <Field label="Longitude" value={fmtLon(tel.lonDeg)} mono />}
          {tel.altKm !== undefined && <Field label="Altitude" value={`${fmtNum(tel.altKm, 1)} km`} mono />}
          <Field label="Geocentric range" value={fmtDist(tel.rangeKm)} mono />
          <Field label="Speed" value={tel.speedKmS !== undefined ? `${fmtNum(tel.speedKmS, 3)} km/s` : undefined} mono />
          <Field label="Period" value={tel.periodSec ? fmtDuration(tel.periodSec) : undefined} mono />
          <Field label="Phase" value={tel.phase?.replace(/_/g, ' ')} />
          <Field label="Confidence" value={conf?.text} mono tone={conf?.tone} />
          <Field label="Element age" value={tel.elementAgeDays !== undefined ? `${fmtNum(tel.elementAgeDays, 1)} d` : undefined} mono />
          {tel.shell && <Field label="Display" value="Compressed deep-space shell (distance not to scale)" tone="warn" />}
        </dl>
      )}

      {showIss && (
        <>
          <div className="section-title">ISS LIVE FIX</div>
          {iss.fix ? (
            <dl className="kv">
              <Field label="Latitude" value={fmtLat(iss.fix.latitude)} mono />
              <Field label="Longitude" value={fmtLon(iss.fix.longitude)} mono />
              <Field label="Altitude" value={`${fmtNum(iss.fix.altitudeKm, 1)} km`} mono />
              <Field label="Velocity" value={`${fmtNum(iss.fix.velocityKmh, 0)} km/h`} mono />
              <Field label="Visibility" value={iss.fix.visibility} />
              <Field label="Footprint" value={`${fmtNum(iss.fix.footprintKm, 0)} km`} mono />
              <Field label="Fix age" value={fmtAgo(iss.fix.t, wall)} mono />
            </dl>
          ) : (
            <div className="empty">Waiting for the iss topic...</div>
          )}
          {iss.telemetry.length > 0 && (
            <table className="tm-table">
              <tbody>
                {iss.telemetry.map((p) => (
                  <tr key={p.id}>
                    <td className="dim">{p.label}</td>
                    <td className="mono">{p.value}</td>
                    <td className="dim">{p.unit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {(link || code) && (
        <>
          <div className="section-title">DEEP SPACE NETWORK LINK</div>
          {link ? (
            <dl className="kv">
              <Field label="Dish" value={`${link.dish} (${link.complex})`} />
              <Field label="Range" value={fmtDist(link.rangeKm)} mono />
              <Field label="Round-trip light time" value={fmtDuration(link.rtltSec)} mono />
              <Field label="Az / El" value={link.azimuthDeg !== undefined ? `${fmtNum(link.azimuthDeg, 1)}° / ${fmtNum(link.elevationDeg, 1)}°` : undefined} mono />
              <Field label="Downlink" value={link.downlink?.active ? `${link.downlink.band ?? ''} ${fmtBitrate(link.downlink.dataRateBps)}`.trim() : 'inactive'} mono />
              <Field label="Uplink" value={link.uplink ? (link.uplink.active ? `${link.uplink.band ?? ''} ${fmtBitrate(link.uplink.dataRateBps)}`.trim() : 'inactive') : undefined} mono />
            </dl>
          ) : (
            <div className="empty">No dish is tracking {code} in the latest snapshot.</div>
          )}
        </>
      )}

      {attrs.length > 0 && (
        <>
          <div className="section-title">ATTRIBUTES</div>
          <dl className="kv">
            {attrs.map(([k, v]) => (
              <Field key={k} label={humanize(k)} value={typeof v === 'number' ? fmtNum(v, Number.isInteger(v) ? 0 : 2) : String(v)} mono={typeof v === 'number'} />
            ))}
          </dl>
        </>
      )}

      {Object.keys(rec.aliases).length > 0 && (
        <>
          <div className="section-title">IDENTIFIERS</div>
          <dl className="kv">
            <Field label="id" value={rec.id} mono />
            {Object.entries(rec.aliases).map(([k, v]) => <Field key={k} label={k} value={v} mono />)}
          </dl>
        </>
      )}
    </div>
  );
}
