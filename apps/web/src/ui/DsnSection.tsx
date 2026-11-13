import { dsnEntityId } from '../lib/entity';
import { fmtAgo, fmtBitrate, fmtDist, fmtLightTime } from '../lib/format';
import { useStore } from '../state/store';
import { useWallNow } from './hooks';

/** Active DSN dish <-> spacecraft links, the DSN part of the Data streams popup; clicking a spacecraft locates it on the globe. */
export function DsnSection() {
  const dsn = useStore((s) => s.dsn);
  const entities = useStore((s) => s.entities);
  const selectObject = useStore((s) => s.selectObject);
  const wall = useWallNow(1000);

  const active = (dsn?.links ?? []).filter((l) => l.downlink?.active || l.uplink?.active);
  const idle = (dsn?.links ?? []).filter((l) => !(l.downlink?.active || l.uplink?.active));

  return (
    <div className="dsn">
      <div className="ds-sub">
        <span>Dishes and links</span>
        <span className="mono dim">{dsn ? `${active.length} active · ${fmtAgo(dsn.fetchedAt, wall)}` : 'no data'}</span>
      </div>
      {!dsn ? (
        <div className="empty">Waiting for DSN snapshot...</div>
      ) : (
        <table className="dsn-table">
          <thead>
            <tr><th>Dish</th><th>Craft</th><th className="num">Range</th><th className="num">RTLT</th><th className="num">Down</th></tr>
          </thead>
          <tbody>
            {[...active, ...idle].map((l) => {
              const on = l.downlink?.active || l.uplink?.active;
              return (
                <tr key={l.dish} className={on ? '' : 'idle'}>
                  <td><i className={`dot ${on ? 'ok' : 'dim'}`} /><span className="mono">{l.dish}</span> <small className="dim">{l.complex}</small></td>
                  <td>
                    {l.spacecraft.map((code) => {
                      const id = dsnEntityId(code);
                      const rec = entities.get(id);
                      return (
                        <button key={code} className="chip link" disabled={!rec} onClick={() => selectObject(id)} title={rec ? `Locate ${rec.name}` : `${code}: not in catalog`}>
                          {code}
                        </button>
                      );
                    })}
                  </td>
                  <td className="num mono">{fmtDist(l.rangeKm)}</td>
                  <td className="num mono">{fmtLightTime(l.rtltSec)}</td>
                  <td className="num mono">{l.downlink?.active ? `${l.downlink.band ?? ''} ${fmtBitrate(l.downlink.dataRateBps)}`.trim() : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
