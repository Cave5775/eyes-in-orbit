import type { EntityRecord } from '@eio/core';
import { isIss } from '../../lib/entity';
import {
  fmtAgo, fmtAttr, fmtBitrate, fmtDeg, fmtDist, fmtElementAge, fmtKm, fmtLat, fmtLightTime, fmtLon, fmtPercent, fmtPeriod, fmtShortUtc,
  fmtSpeedKmS, fmtSpeedKmh, fmtTelemetryValue, humanize,
} from '../../lib/format';
import { computeTelemetry } from '../../lib/telemetry';
import { ensureInGraph, graph } from '../../state/runtime';
import { useFrameInfo, useStore } from '../../state/store';
import { useSimNow, useWallNow } from '../hooks';
import { Field } from './Field';
import { IssArraysSection } from './IssArraysSection';

function confidenceLabel(c: number | undefined): { text: string; tone: string } | null {
  if (c === undefined) return null;
  return { text: fmtPercent(c), tone: c > 0.8 ? 'ok' : c > 0.4 ? 'warn' : 'bad' };
}

export function TelemetryTab({ rec }: { rec: EntityRecord }) {
  const now = useSimNow(250);
  const wall = useWallNow(1000);
  const iss = useStore((s) => s.iss);
  const dsn = useStore((s) => s.dsn);
  const frame = useFrameInfo();
  const centreRec = useStore((s) => (s.frame.kind === 'entity' ? s.entities.get(s.frame.id) : undefined));
  ensureInGraph(rec);
  if (centreRec) ensureInGraph(centreRec); // an entity centre is looked up in the graph
  const tel = computeTelemetry(graph, rec, now, frame.centre);
  const range = tel ? undefined : graph.provider(rec.id)?.validRange;
  const conf = confidenceLabel(tel?.confidence);
  const code = rec.aliases.dsn;
  const link = code ? dsn?.links.find((l) => l.spacecraft.includes(code)) : undefined;
  const showIss = isIss(rec);
  const attrs = Object.entries(rec.attrs ?? {}).filter(([, v]) => v !== null && v !== '');
  // the SARJ / BGA / attitude items are summarised in the ARRAYS section; the table keeps the rest of the raw feed
  const tableRows = iss.telemetry.filter((p) => !/^(S000000[345]|[PS][46]00000[78]|USLAB0000(1[89]|2[01]))$/.test(p.id));

  return (
    <div>
      <div className="section-title">STATE @ SIM TIME</div>
      {!tel ? (
        <div className="empty">
          No state available at this time (outside the provider's valid range).
          {range && <div className="mono dim">Data covers {fmtShortUtc(range[0])} to {fmtShortUtc(range[1])}</div>}
        </div>
      ) : (
        <dl className="kv">
          {tel.latDeg !== undefined && <Field label="Latitude" value={fmtLat(tel.latDeg)} mono />}
          {tel.lonDeg !== undefined && <Field label="Longitude" value={fmtLon(tel.lonDeg)} mono />}
          {tel.altKm !== undefined && <Field label="Altitude" value={fmtKm(tel.altKm)} mono />}
          <Field label="Geocentric range" value={fmtDist(tel.rangeKm)} mono />
          {tel.refRangeKm !== undefined && <Field label={`Range from ${frame.label}`} value={fmtDist(tel.refRangeKm)} mono />}
          {tel.refSpeedKmS !== undefined && <Field label={`Speed rel. ${frame.label}`} value={fmtSpeedKmS(tel.refSpeedKmS)} mono />}
          <Field label="Speed" value={tel.speedKmS !== undefined ? fmtSpeedKmS(tel.speedKmS) : undefined} mono />
          <Field label="Period" value={tel.periodSec ? fmtPeriod(tel.periodSec) : undefined} mono />
          <Field label="Phase" value={tel.phase?.replace(/_/g, ' ')} />
          <Field label="Confidence" value={conf?.text} mono tone={conf?.tone} />
          <Field label="Element age" value={tel.elementAgeDays !== undefined ? fmtElementAge(tel.elementAgeDays) : undefined} mono />
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
              <Field label="Altitude" value={fmtKm(iss.fix.altitudeKm)} mono />
              <Field label="Velocity" value={fmtSpeedKmh(iss.fix.velocityKmh)} mono />
              <Field label="Visibility" value={iss.fix.visibility} />
              <Field label="Footprint" value={fmtKm(iss.fix.footprintKm, 0)} mono />
              <Field label="Fix age" value={fmtAgo(iss.fix.t, wall)} mono />
            </dl>
          ) : (
            <div className="empty">Waiting for the iss topic...</div>
          )}
          <IssArraysSection rec={rec} now={now} wall={wall} />
          {tableRows.length > 0 && (
            <table className="tm-table">
              <tbody>
                {tableRows.map((p) => (
                  <tr key={p.id}>
                    <td className="dim">{p.label}</td>
                    <td className="mono">{fmtTelemetryValue(p.value)}</td>
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
              <Field label="Round-trip light time" value={fmtLightTime(link.rtltSec)} mono />
              <Field label="Az / El" value={link.azimuthDeg !== undefined ? `${fmtDeg(link.azimuthDeg)} / ${fmtDeg(link.elevationDeg)}` : undefined} mono />
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
              <Field key={k} label={humanize(k)} value={fmtAttr(k, v as string | number | boolean)} mono={typeof v === 'number'} />
            ))}
          </dl>
        </>
      )}

      {Object.keys(rec.aliases).length > 0 && (
        <>
          <div className="section-title">IDENTIFIERS</div>
          <dl className="kv">
            <Field label="id" value={rec.id} mono wrap />
            {Object.entries(rec.aliases).map(([k, v]) => <Field key={k} label={k} value={v} mono wrap />)}
          </dl>
        </>
      )}
    </div>
  );
}
