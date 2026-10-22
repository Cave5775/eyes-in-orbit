import { WebSocket } from 'ws';
import type { TelemetryPoint } from '@eio/core';
import type { Connector } from '../connector';

const URL = 'wss://push.lightstreamer.com/lightstreamer';
const PROTOCOL = 'TLCP-2.5.0.lightstreamer.com';
const HANDSHAKE_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 20_000;
const FLUSH_MS = 1000;

/**
 * Items of the public ISSLIVE adapter. The id -> label mapping comes from the reference document and
 * is UNVERIFIED: live values of USLAB000032/33 do not look like geodetic position / velocity.
 */
export const ISS_ITEMS: { id: string; label: string; unit?: string }[] = [
  { id: 'USLAB000032', label: 'State vector geodetic position (reference doc, unverified)' },
  { id: 'USLAB000033', label: 'Orbital velocity vector (reference doc, unverified)' },
  { id: 'S0000001', label: 'Solar array joint / beta gimbal angle 1 (reference doc, unverified)', unit: 'deg' },
  { id: 'S0000002', label: 'Solar array joint / beta gimbal angle 2 (reference doc, unverified)', unit: 'deg' },
  { id: 'S0000003', label: 'Solar array joint / beta gimbal angle 3 (reference doc, unverified)', unit: 'deg' },
  { id: 'S0000004', label: 'Solar array joint / beta gimbal angle 4 (reference doc, unverified)', unit: 'deg' },
];
const FIELDS = ['TimeStamp', 'Value'];

/**
 * Apply one TLCP update payload (`a|b||^2|...`) to the previous field values.
 * Empty = unchanged, `#` = null, `$` = empty string, `^N` = N unchanged fields, else percent-encoded text.
 */
export function decodeUpdate(prev: (string | null)[], payload: string): (string | null)[] {
  const out = [...prev];
  let i = 0;
  for (const tok of payload.split('|')) {
    if (tok === '') i++;
    else if (tok === '#') out[i++] = null;
    else if (tok === '$') out[i++] = '';
    else if (tok.startsWith('^')) i += Number(tok.slice(1));
    else {
      let v = tok;
      try { v = decodeURIComponent(tok); } catch { /* keep raw */ }
      out[i++] = v;
    }
  }
  return out;
}

/** ISSLIVE `TimeStamp` is fractional hours since 00:00 UTC on Dec 31 (day-of-year is 1-based). */
export function issTimestampMs(hoursOfYear: number, nowMs = Date.now()): number {
  const year = new Date(nowMs).getUTCFullYear();
  const t = Date.UTC(year, 0, 0) + hoursOfYear * 3_600_000;
  return t > nowMs + 86_400_000 ? Date.UTC(year - 1, 0, 0) + hoursOfYear * 3_600_000 : t;
}

export function telemetryPoint(itemId: string, fields: (string | null)[], nowMs = Date.now()): TelemetryPoint | undefined {
  const item = ISS_ITEMS.find((x) => x.id === itemId);
  const ts = Number(fields[0]);
  if (!item || fields[1] == null) return undefined;
  return { id: item.id, label: item.label, unit: item.unit, value: fields[1], t: Number.isFinite(ts) ? issTimestampMs(ts, nowMs) : nowMs };
}

/** Best-effort Lightstreamer (TLCP over WebSocket) client; runs only while topic `iss` has subscribers. */
export const issLive: Connector = {
  id: 'iss-live',
  intervalMs: 5000,
  topic: 'iss',
  run(ctx) {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(URL, PROTOCOL);
      const state = ISS_ITEMS.map(() => [null, null] as (string | null)[]);
      const pending = new Map<string, TelemetryPoint>();
      let connected = false;
      let idle: NodeJS.Timeout;

      const watchdog = () => {
        clearTimeout(idle);
        idle = setTimeout(
          () => end(new Error(connected ? 'no data from Lightstreamer for 20 s' : 'Lightstreamer handshake timed out')),
          connected ? IDLE_TIMEOUT_MS : HANDSHAKE_TIMEOUT_MS,
        );
      };
      const flush = setInterval(() => {
        if (pending.size) ctx.hub.setTelemetry([...pending.values()]);
        pending.clear();
      }, FLUSH_MS);
      const onTopic = ({ topic, count }: { topic: string; count: number }) => {
        if (topic === 'iss' && count === 0) end();
      };
      ctx.hub.on('topic', onTopic);

      const end = (err?: Error) => {
        clearTimeout(idle);
        clearInterval(flush);
        ctx.hub.off('topic', onTopic);
        ws.removeAllListeners();
        ws.on('error', () => {});
        ws.terminate();
        if (err) {
          ctx.health.note = `Lightstreamer ISSLIVE unavailable (${err.message}); item ids are unverified`;
          reject(err);
        } else resolve();
      };

      watchdog();
      ws.on('open', () => ws.send('create_session\r\nLS_adapter_set=ISSLIVE&LS_cid=mgQkwtwdysogQz2BJ4Ji%20kOj2Bg&LS_send_sync=false&LS_cause=api'));
      ws.on('error', (e) => end(e));
      ws.on('unexpected-response', (_, res) => end(new Error(`HTTP ${res.statusCode} during WebSocket upgrade`)));
      ws.on('close', () => end(connected ? undefined : new Error('socket closed before session was created')));
      ws.on('message', (data) => {
        watchdog();
        for (const line of data.toString().split(/\r?\n/)) {
          const [cmd, ...rest] = line.split(',');
          if (cmd === 'CONOK') {
            connected = true;
            ctx.health.note = 'Lightstreamer ISSLIVE connected; item-id to label mapping is from the reference doc and unverified';
            const group = ISS_ITEMS.map((i) => i.id).join('%20');
            ws.send(`control\r\nLS_reqId=1&LS_op=add&LS_subId=1&LS_mode=MERGE&LS_group=${group}&LS_schema=${FIELDS.join('%20')}&LS_data_adapter=DEFAULT&LS_snapshot=true`);
          } else if (cmd === 'U') {
            const [, itemPos, ...payload] = rest;
            const idx = Number(itemPos) - 1;
            if (!ISS_ITEMS[idx]) continue;
            state[idx] = decodeUpdate(state[idx], payload.join(','));
            const p = telemetryPoint(ISS_ITEMS[idx].id, state[idx]);
            if (p) pending.set(p.id, p);
          } else if (cmd === 'CONERR' || cmd === 'REQERR' || cmd === 'ERROR') {
            end(new Error(`${cmd} ${rest.join(',')}`));
          } else if (cmd === 'END' || cmd === 'LOOP') end();
        }
      });
    });
  },
};
