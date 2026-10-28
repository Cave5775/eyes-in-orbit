import { formatCountdown } from '@eio/core';
import { fmtShortUtc, fmtUtc } from '../lib/format';
import { liveMission, statusTone } from '../lib/launch';
import { skipTitle } from '../lib/launch-seek';
import { skipToLaunch } from '../state/seek';
import { useStore } from '../state/store';
import { useSimNow } from './hooks';

const KEEP_PAST_MS = 2 * 3_600_000;

export function LaunchBoard() {
  const launches = useStore((s) => s.launches);
  const selectedId = useStore((s) => s.selectedId);
  const focusLaunch = useStore((s) => s.focusLaunch);
  const now = useSimNow(500);

  const board = launches.filter((l) => Date.parse(l.net) > now - KEEP_PAST_MS).sort((a, b) => Date.parse(a.net) - Date.parse(b.net));

  return (
    <section className="panel board">
      <div className="panel-head">
        <span>LAUNCH BOARD</span>
        <span className="mono dim">{board.length} upcoming</span>
      </div>
      {board.length === 0 ? (
        <div className="empty">No upcoming launches loaded.</div>
      ) : (
        <div className="cards">
          {board.map((l) => {
            const m = liveMission(l, now);
            const net = Date.parse(l.net);
            return (
              <div key={l.id} className="card-box">
                <button className={l.entityId === selectedId ? 'card sel' : 'card'} onClick={() => focusLaunch(l)} title={l.name}>
                  <div className={`cd mono ${net - now < 0 ? 'ok' : net - now < 3_600_000 ? 'accent' : ''}`}>{formatCountdown(net - now)}</div>
                  <div className="card-name">{l.mission?.name ?? l.name}</div>
                  <div className="card-sub dim">{l.vehicle ?? l.provider} · {l.pad?.location ?? l.pad?.name ?? 'pad unknown'}</div>
                  <div className="chips tight">
                    <span className={`chip ${statusTone(l.status.id)}`}>{l.status.abbrev}</span>
                    <span className="chip">{m.phase.replace(/_/g, ' ')}</span>
                    <span className="mono dim card-net">{fmtShortUtc(net)}</span>
                  </div>
                </button>
                {Number.isFinite(net) && (
                  <button className="card-skip" onClick={() => skipToLaunch(l)} title={skipTitle(l.status.id, `${fmtUtc(net)} UTC`)} aria-label={`Skip to launch: ${l.mission?.name ?? l.name}`}>
                    SKIP
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
