import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatCountdown, sampleAscentRows, type AscentEvent, type AscentSeries, type Launch } from '@eio/core';
import { api } from '../../api/client';
import {
  METRICS, chartDomain, chartSeries, fmtAxisT, fmtTPlus, labelY, layoutLabels, linePath, linear, niceTicks, phaseNow, plotTimeAt, readingAt,
  timeTicks, timelineEvents, timelinePhases, valueDomain, visibleRows, type ChartSeries, type Metric, type Reading, type SeriesId,
} from '../../lib/ascent-chart';
import { fmtDeg, fmtKm, fmtNum, fmtSpeedKmS, fmtUtc } from '../../lib/format';
import { jumpTitle } from '../../lib/launch-seek';
import { jumpToFlightTime } from '../../state/seek';
import { useStore } from '../../state/store';
import { useSimNow } from '../hooks';
import './AscentTelemetry.css';

const W = 340;
const PLOT = { left: 40, right: 10 };
const X0 = PLOT.left, X1 = W - PLOT.right;

const SERIES_CLASS: Record<SeriesId, string> = { modeled: 'at-modeled', live: 'at-live', file: 'at-file' };
const SOURCE_TEXT: Record<Reading['source'], string> = {
  live: 'MEASURED', extrapolated: 'EXTRAPOLATED (modeled shape)', modeled: 'MODELED', file: 'FILE',
};

const fmtValue = (metric: Metric, v: number | undefined): string => (metric === 'speedKmS' ? fmtSpeedKmS(v) : fmtKm(v));

/** Telemetry section of the Launch tab: modeled / measured ascent charts, event timeline and readouts at the simulation T+. */
export function AscentTelemetry({ launch }: { launch: Launch }) {
  const stamp = useStore((s) => s.entities.get(launch.entityId)?.updatedAt);
  const [series, setSeries] = useState<AscentSeries | null | undefined>(undefined);
  const [hoverT, setHoverT] = useState<number | null>(null);
  const now = useSimNow(200);

  const load = useCallback(() => {
    let alive = true;
    api.ascent(launch.id).then((s) => alive && setSeries(s), () => alive && setSeries(null));
    return () => { alive = false; };
  }, [launch.id]);

  useEffect(() => load(), [load, launch.net, stamp]);

  const liftoffMs = series?.liftoffMs ?? Date.parse(launch.net);
  const tSec = (now - liftoffMs) / 1000;
  const tMax = useMemo(() => (series ? chartDomain(series).tMax : 0), [series]);
  /** seek the simulation clock to T+`t` of this flight, at the current rate (clamped to the charted range) */
  const jump = useCallback((t: number) => jumpToFlightTime(liftoffMs, Math.max(0, Math.min(t, tMax))), [liftoffMs, tMax]);

  // poll while the vehicle is flying so rows posted by a script show up even without a push
  const flying = !!series && tSec >= -30 && tSec <= tMax + 60;
  useEffect(() => {
    if (!flying) return;
    let cancel: (() => void) | undefined;
    const id = setInterval(() => { cancel?.(); cancel = load(); }, 5000);
    return () => { clearInterval(id); cancel?.(); };
  }, [flying, load]);

  if (series === undefined) return <div className="at"><div className="section-title">ASCENT TELEMETRY</div><div className="at-note dim">Loading…</div></div>;
  if (series === null || (!series.modeled && !series.live && !series.file)) {
    return (
      <div className="at">
        <div className="section-title">ASCENT TELEMETRY</div>
        <p className="at-note dim">
          No ascent profile for this vehicle: modeled ascents cover Falcon 9. Measured rows can be posted to
          <span className="mono"> POST /api/telemetry/{launch.id}</span>.
        </p>
      </div>
    );
  }

  const events = timelineEvents(series);
  const phase = phaseNow(series, tSec);
  const reading = readingAt(series, Math.max(0, tSec));
  const inFlight = tSec >= 0 && tSec <= tMax;
  const phaseLabel = tSec < 0 ? 'PRE-LAUNCH' : phase?.label ?? (tSec > tMax ? 'ASCENT COMPLETE' : 'IN FLIGHT');
  const m = series.modeled;

  return (
    <div className="at">
      <div className="section-title">ASCENT TELEMETRY</div>
      <div className="chips tight at-chips">
        {series.source === 'live' && <span className="chip ok">LIVE · MEASURED</span>}
        {series.source === 'file' && <span className="chip">TRAJECTORY FILE{series.file ? ` · ${series.file.id}` : ''}</span>}
        {series.source === 'modeled' && <span className="chip warn">MODELED · NOMINAL</span>}
        <span className={inFlight ? 'chip on' : 'chip dim'} data-testid="at-phase">{phaseLabel}</span>
      </div>

      {tSec < 0 ? <PlanReadouts series={series} tMs={liftoffMs - now} /> : <Readouts reading={reading} tSec={tSec} />}

      <div className="at-legend" aria-hidden="true">
        {m && <span><i className={`at-sw ${series.live ? 'dash' : ''} at-modeled`} />Modeled nominal</span>}
        {series.file && <span><i className="at-sw at-file" />File</span>}
        {series.live && <span><i className="at-sw at-live" />Measured</span>}
        <span><i className="at-sw cursor" />Now (sim T+)</span>
      </div>

      {METRICS.map((mt) => (
        <Chart key={mt.key} metric={mt.key} title={mt.title} unit={mt.unit} series={chartSeries(series, mt.key)} events={events} tMax={tMax}
          cursorT={inFlight ? tSec : null} reading={inFlight ? reading : null} hoverT={hoverT} onHover={setHoverT} onJump={jump} liveRows={series.live?.rows.length ?? 0} />
      ))}

      <Timeline series={series} events={events} tMax={tMax} tSec={tSec} hoverT={hoverT} onHover={setHoverT} onJump={jump} />

      <EventTable events={events} liftoffMs={liftoffMs} tSec={tSec} onJump={jump} />

      <p className="at-note dim">
        {series.source === 'live'
          ? `Measured rows from ${series.live?.source ?? 'a POST to /api/telemetry'}; after T+${Math.round(series.live?.extrapolatedFromSec ?? series.live?.lastTSec ?? 0)} s the path follows the modeled shape.`
          : series.source === 'file'
            ? 'Path from a trajectory file in data/trajectories (not measured by this app).'
            : 'Modeled from typical Falcon 9 figures. Nothing here is measured; real flights differ by tens of seconds and a few percent.'}
        {m && ` Inclination ${fmtDeg(m.inclinationDeg)} (${m.inclinationSource.replace(/-/g, ' ')}), azimuth ${fmtDeg(m.azimuthDeg)}.`}
        {' '}Post measured rows to <span className="mono">POST /api/telemetry/{launch.id}</span>.
      </p>

      <DataTable series={series} tMax={tMax} />
    </div>
  );
}

// ---------------------------------------------------------------- readouts

function Readouts({ reading, tSec }: { reading: Reading | null; tSec: number }) {
  return (
    <div className="at-readouts" role="group" aria-label="Current values at the simulation time">
      <Cell label="SIM TIME" value={fmtTPlus(tSec)} />
      <Cell label="ALTITUDE" value={fmtKm(reading?.altKm)} />
      <Cell label="SPEED" value={fmtSpeedKmS(reading?.speedKmS)} />
      <Cell label="DOWNRANGE" value={fmtKm(reading?.downrangeKm)} />
      <div className="at-src dim">{reading ? SOURCE_TEXT[reading.source] : ''}</div>
    </div>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return <div className="at-cell"><span className="at-lab">{label}</span><span className="mono at-val">{value}</span></div>;
}

/** Before liftoff: the countdown and the nominal figures of the key events. */
function PlanReadouts({ series, tMs }: { series: AscentSeries; tMs: number }) {
  const picks = ['MAX_Q', 'MECO', 'SECO'].map((n) => timelineEvents(series).find((e) => e.name === n)).filter((e): e is AscentEvent => !!e);
  return (
    <div className="at-readouts plan" role="group" aria-label="Launch plan">
      <Cell label="LIFTOFF" value={formatCountdown(tMs)} />
      {picks.map((e) => (
        <div className="at-cell" key={e.name}>
          <span className="at-lab">{e.label} · {fmtTPlus(e.tSec)}</span>
          <span className="mono at-val">{fmtKm(e.altKm)} · {fmtSpeedKmS(e.speedKmS)}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- charts

interface ChartProps {
  metric: Metric;
  title: string;
  unit: string;
  series: ChartSeries[];
  events: AscentEvent[];
  tMax: number;
  cursorT: number | null;
  reading: Reading | null;
  hoverT: number | null;
  onHover: (t: number | null) => void;
  /** click: jump the simulation clock to T+ t */
  onJump: (t: number) => void;
  liveRows: number;
}

const CH = { h: 104, top: 8, bottom: 18 };

function Chart({ metric, title, unit, series, events, tMax, cursorT, reading, hoverT, onHover, onJump, liveRows }: ChartProps) {
  const [, top] = valueDomain(series, tMax);
  const x = linear(0, tMax, X0, X1);
  const y = linear(0, top, CH.h - CH.bottom, CH.top);
  const yTicks = niceTicks(0, top, 3);
  const digits = metric === 'speedKmS' ? 1 : 0;
  const vehicleEvents = events.filter((e) => e.track === 'vehicle' && e.tSec > 0 && e.tSec <= tMax);

  const valueAt = (t: number): string | null => {
    const live = series.find((s) => s.id === 'live'), plan = series.find((s) => s.id !== 'live');
    const rows = (live && t <= live.rows[live.rows.length - 1].tSec && t >= live.rows[0].tSec ? live : plan ?? live)?.rows;
    const r = rows && sampleAscentRows(rows, t);
    return r ? `${fmtTPlus(t)}  ${fmtValue(metric, r.value)}` : null;
  };
  const hoverLabel = hoverT !== null ? valueAt(hoverT) : null;
  const cursorValue = reading ? reading[metric] : undefined;

  return (
    <figure className="at-chart">
      <figcaption><span>{title}</span><span className="dim"> {unit}</span></figcaption>
      <svg className="at-jumpable" viewBox={`0 0 ${W} ${CH.h}`} role="img" aria-label={`${title} against time since liftoff${series.length ? '' : ', no data'}`}
        onPointerMove={(e) => onHover(plotTimeAt(svgX(e), X0, X1, tMax))}
        onPointerLeave={() => onHover(null)}
        onClick={(e) => {
          const t = plotTimeAt(svgX(e), X0, X1, tMax);
          if (t !== null) onJump(t);
        }}>
        <title>{hoverT !== null ? jumpTitle(hoverT) : 'click to jump to a time'}</title>
        {yTicks.map((v) => (
          <g key={v}>
            <line className="at-grid" x1={X0} x2={X1} y1={y(v)} y2={y(v)} />
            <text className="at-axis" x={X0 - 4} y={y(v) + 3} textAnchor="end">{fmtNum(v, digits)}</text>
          </g>
        ))}
        {timeTicks(tMax).map((t) => <text key={t} className="at-axis" x={x(t)} y={CH.h - 5} textAnchor="middle">{fmtAxisT(t)}</text>)}
        {vehicleEvents.map((e) => <line key={e.name} className="at-evtick" x1={x(e.tSec)} x2={x(e.tSec)} y1={CH.top} y2={CH.h - CH.bottom} />)}
        {series.map((s) => (
          <path key={s.id} className={`at-line ${SERIES_CLASS[s.id]} ${s.id === 'modeled' && liveRows ? 'dash' : ''}`}
            d={linePath(visibleRows(s.rows, tMax).map((r) => [x(r.tSec), y(r.value)]))} fill="none" />
        ))}
        {series.filter((s) => s.id === 'live' && s.rows.length <= 90).map((s) => s.rows.filter((r) => r.tSec <= tMax).map((r) => (
          <circle key={r.tSec} className="at-pt at-live" cx={x(r.tSec)} cy={y(r.value)} r={1.8} />
        )))}
        {hoverT !== null && <line className="at-hover" x1={x(hoverT)} x2={x(hoverT)} y1={CH.top} y2={CH.h - CH.bottom} />}
        {cursorT !== null && (
          <g className="at-cursor" aria-hidden="true">
            <line x1={x(cursorT)} x2={x(cursorT)} y1={CH.top} y2={CH.h - CH.bottom} />
            {cursorValue !== undefined && <circle cx={x(cursorT)} cy={y(Math.min(cursorValue, top))} r={3} />}
          </g>
        )}
        {hoverLabel && <text className="at-tip" x={X1} y={CH.top + 2} textAnchor="end">{hoverLabel}</text>}
      </svg>
    </figure>
  );
}

// ---------------------------------------------------------------- timeline

const TL = { h: 112, labelRows: 3, rowH: 10, bandY: 38, bandH: 14, boosterY: 74 };

function Timeline({ series, events, tMax, tSec, hoverT, onHover, onJump }: {
  series: AscentSeries; events: AscentEvent[]; tMax: number; tSec: number; hoverT: number | null; onHover: (t: number | null) => void;
  onJump: (t: number) => void;
}) {
  const x = linear(0, tMax, X0, X1);
  const phases = timelinePhases(series);
  const current = phaseNow(series, tSec);
  const vehicle = events.filter((e) => e.track === 'vehicle' && e.name !== 'LIFTOFF' && e.tSec <= tMax);
  const booster = events.filter((e) => e.track === 'booster' && e.tSec <= tMax);
  const vLabels = layoutLabels(vehicle.map((e) => ({ x: x(e.tSec), text: e.label })), W - 2, { maxRows: TL.labelRows });
  const bLabels = layoutLabels(booster.map((e) => ({ x: x(e.tSec), text: e.label })), W - 2, { maxRows: 2 });

  return (
    <figure className="at-chart at-timeline">
      <figcaption><span>EVENTS</span><span className="dim"> T+ · {current ? current.label : tSec < 0 ? 'pre-launch' : 'ascent complete'}</span></figcaption>
      <svg className="at-jumpable" viewBox={`0 0 ${W} ${TL.h}`} role="img" aria-label="Ascent event timeline"
        onPointerMove={(e) => onHover(plotTimeAt(svgX(e), X0, X1, tMax))}
        onPointerLeave={() => onHover(null)}
        onClick={(e) => {
          const t = plotTimeAt(svgX(e), X0, X1, tMax);
          if (t !== null) onJump(t);
        }}>
        <title>{hoverT !== null ? jumpTitle(hoverT) : 'click to jump to a time'}</title>
        <text className="at-axis" x={X0 - 4} y={TL.bandY + 10} textAnchor="end">VEH</text>
        {phases.map((p) => {
          const x0 = x(p.fromSec), x1 = x(Math.min(p.toSec, tMax));
          const on = current?.id === p.id;
          return (
            <g key={p.id}>
              <rect className={on ? 'at-band on' : 'at-band'} x={x0} y={TL.bandY} width={Math.max(1, x1 - x0 - 1)} height={TL.bandH} rx={2} />
              {x1 - x0 > p.label.length * 5.2 + 6 && <text className={on ? 'at-bandlab on' : 'at-bandlab'} x={(x0 + x1) / 2} y={TL.bandY + 10} textAnchor="middle">{p.label}</text>}
            </g>
          );
        })}
        {vehicle.map((e, i) => {
          const l = vLabels[i];
          const ly = labelY(l.row, TL.labelRows, TL.bandY, TL.rowH);
          return (
            <g key={e.name} className={tSec >= e.tSec ? 'at-ev past' : 'at-ev'} onClick={(ev) => { ev.stopPropagation(); onJump(e.tSec); }}>
              <title>{`${e.label} ${fmtTPlus(e.tSec)}${e.reported ? ' (reported)' : ' (modeled)'} - ${jumpTitle(e.tSec)}`}</title>
              <line x1={l.x} x2={l.x} y1={ly + 2} y2={TL.bandY + TL.bandH} />
              <text x={l.x + (l.anchor === 'end' ? 2 : -2)} y={ly} textAnchor={l.anchor}>{e.label}</text>
            </g>
          );
        })}
        {booster.length > 0 && (
          <>
            <text className="at-axis" x={X0 - 4} y={TL.boosterY + 3} textAnchor="end">BSTR</text>
            <line className="at-grid" x1={X0} x2={X1} y1={TL.boosterY} y2={TL.boosterY} />
            {booster.map((e, i) => {
              const l = bLabels[i];
              return (
                <g key={e.name} className={tSec >= e.tSec ? 'at-ev past' : 'at-ev'} onClick={(ev) => { ev.stopPropagation(); onJump(e.tSec); }}>
                  <title>{`${e.label} ${fmtTPlus(e.tSec)}${e.reported ? ' (reported)' : ' (modeled)'} - ${jumpTitle(e.tSec)}`}</title>
                  <circle cx={l.x} cy={TL.boosterY} r={3} />
                  <text x={l.x + (l.anchor === 'end' ? 3 : -3)} y={TL.boosterY + 12 + l.row * TL.rowH} textAnchor={l.anchor}>{e.label}</text>
                </g>
              );
            })}
          </>
        )}
        {timeTicks(tMax).map((t) => <text key={t} className="at-axis" x={x(t)} y={TL.h - 3} textAnchor="middle">{fmtAxisT(t)}</text>)}
        {hoverT !== null && <line className="at-hover" x1={x(hoverT)} x2={x(hoverT)} y1={2} y2={TL.h - 12} />}
        {tSec >= 0 && tSec <= tMax && <line className="at-cursor-line" x1={x(tSec)} x2={x(tSec)} y1={2} y2={TL.h - 12} />}
      </svg>
    </figure>
  );
}

/** Pointer x in the charts' viewBox units. */
function svgX(e: { clientX: number; currentTarget: Element }): number {
  const r = e.currentTarget.getBoundingClientRect();
  return ((e.clientX - r.left) / r.width) * W;
}

function EventTable({ events, liftoffMs, tSec, onJump }: { events: AscentEvent[]; liftoffMs: number; tSec: number; onJump: (t: number) => void }) {
  if (!events.length) return null;
  return (
    <table className="at-events">
      <caption className="at-sr">Ascent events</caption>
      <thead><tr><th scope="col">Event</th><th scope="col">T+</th><th scope="col">UTC</th><th scope="col">Basis</th></tr></thead>
      <tbody>
        {events.map((e) => (
          <tr key={e.name} className={tSec >= e.tSec ? 'jumpable past' : 'jumpable'} title={jumpTitle(e.tSec)} onClick={() => onJump(e.tSec)}>
            <th scope="row">{e.label}{e.track === 'booster' ? ' (booster)' : ''}</th>
            <td className="mono"><button type="button" className="at-jump" aria-label={`${jumpTitle(e.tSec)} (${e.label})`}>{fmtTPlus(e.tSec)}</button></td>
            <td className="mono">{fmtUtc(liftoffMs + e.tSec * 1000).slice(11)}</td>
            <td className="dim">{e.reported ? 'reported' : 'modeled'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Text alternative to the charts: the series every 30 s. */
function DataTable({ series, tMax }: { series: AscentSeries; tMax: number }) {
  const rows = useMemo(() => {
    const out: { t: number; plan?: Reading; live?: Reading }[] = [];
    for (let t = 0; t <= tMax; t += 30) {
      out.push({
        t,
        plan: series.modeled ? { ...sampleAscentRows(series.modeled.rows, t)!, source: 'modeled' } : undefined,
        live: series.live && t >= series.live.rows[0].tSec && t <= series.live.lastTSec ? readingAt(series, t) ?? undefined : undefined,
      });
    }
    return out;
  }, [series, tMax]);
  return (
    <details className="at-data">
      <summary>Data table</summary>
      <table>
        <thead><tr><th scope="col">T+</th><th scope="col">Alt km (model)</th><th scope="col">km/s (model)</th>{series.live && <><th scope="col">Alt km (live)</th><th scope="col">km/s (live)</th></>}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.t}>
              <th scope="row" className="mono">{fmtTPlus(r.t)}</th>
              <td className="mono">{fmtNum(r.plan?.altKm, 1)}</td>
              <td className="mono">{fmtNum(r.plan?.speedKmS, 3)}</td>
              {series.live && <><td className="mono">{fmtNum(r.live?.altKm, 1)}</td><td className="mono">{fmtNum(r.live?.speedKmS, 3)}</td></>}
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
