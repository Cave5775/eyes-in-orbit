import { WebSocket } from 'ws';
import { ISS_CHANNELS, type IssArrays, type IssChannel, type TelemetryPoint } from '@eio/core';
import type { Connector } from '../connector';

const URL = 'wss://push.lightstreamer.com/lightstreamer';
const PROTOCOL = 'TLCP-2.5.0.lightstreamer.com';
const HANDSHAKE_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 20_000;
const FLUSH_MS = 1000;

/**
 * What an ISSLIVE item is, for building the structured `IssArrays` message.
 * Item ids and names come from the ISS Mimic project's public telemetry table (https://iss-mimic.github.io/Mimic/); the
 * `verified` flag says whether this project checked the item against live data (docs/reference.md, "ISS array telemetry").
 */
export type IssRole =
  | { kind: 'sarj'; side: 'port' | 'starboard' }
  | { kind: 'sarj-cmd'; side: 'port' }
  | { kind: 'bga'; channel: IssChannel }
  | { kind: 'att'; comp: 'w' | 'x' | 'y' | 'z' }
  | { kind: 'state' };

export interface IssItem {
  id: string;
  label: string;
  unit?: string;
  verified: boolean;
  role: IssRole;
}

/**
 * Live verification results (2026-10-22, 240 s of 1 Hz data, compared with the sun geometry computed from the ISS state):
 *  - SARJ S0000003 / S0000004: 0..360 deg, +0.0645 / -0.0645 deg/s (orbital rate 0.0646), sum 360.0, and equal to the
 *    computed sun-tracking angle minus a constant 90.15 +/- 0.11 deg once the ISS attitude is applied: VERIFIED.
 *  - USLAB000018-21: LVLH attitude quaternion, unit norm; applying it (body to LVLH) makes the SARJ offset exactly -90
 *    deg (-75 deg the other way round): VERIFIED.
 *  - USLAB000032-37: J2000 position (km) and velocity (m/s): |r| - 6371 = 425 km, speed 7.663 km/s, and the latitude and
 *    longitude computed from it match wheretheiss.at within 0.2 / 0.4 deg (tens of km, the TLE prediction error): VERIFIED.
 *  - BGA items: 0..360 deg, port/starboard mirrored pairs (about 43 / 317 and 137 / 223), drift under 1 deg in 240 s, but
 *    their value (about 43 deg) does not match the computed beta tilt (about 3 deg): the angle's meaning is UNVERIFIED.
 */
export const ISS_VERIFIED = { sarj: true, bga: false, attitude: true } as const;

const bga = (id: string, channel: IssChannel): IssItem => ({
  id, label: `Solar array ${channel} beta gimbal (BGA) angle (unverified)`, unit: 'deg', verified: ISS_VERIFIED.bga, role: { kind: 'bga', channel },
});

export const ISS_ITEMS: IssItem[] = [
  { id: 'S0000003', label: 'Starboard solar alpha rotary joint (SARJ) angle', unit: 'deg', verified: ISS_VERIFIED.sarj, role: { kind: 'sarj', side: 'starboard' } },
  { id: 'S0000004', label: 'Port solar alpha rotary joint (SARJ) angle', unit: 'deg', verified: ISS_VERIFIED.sarj, role: { kind: 'sarj', side: 'port' } },
  { id: 'S0000005', label: 'Port SARJ commanded angle', unit: 'deg', verified: ISS_VERIFIED.sarj, role: { kind: 'sarj-cmd', side: 'port' } },
  bga('P4000007', '2A'), bga('P4000008', '4A'), bga('P6000007', '4B'), bga('P6000008', '2B'),
  bga('S4000007', '1A'), bga('S4000008', '3A'), bga('S6000007', '3B'), bga('S6000008', '1B'),
  ...(['w', 'x', 'y', 'z'] as const).map((comp, i): IssItem => ({
    id: `USLAB0000${18 + i}`, label: `ISS attitude quaternion ${comp.toUpperCase()} (body to LVLH)`, verified: ISS_VERIFIED.attitude, role: { kind: 'att', comp },
  })),
  ...(['X', 'Y', 'Z'] as const).map((c, i): IssItem => ({
    id: `USLAB0000${32 + i}`, label: `State vector position ${c} (J2000)`, unit: 'km', verified: true, role: { kind: 'state' },
  })),
  ...(['X', 'Y', 'Z'] as const).map((c, i): IssItem => ({
    id: `USLAB0000${35 + i}`, label: `State vector velocity ${c} (J2000)`, unit: 'm/s', verified: true, role: { kind: 'state' },
  })),
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
  return { id: item.id, label: item.label, unit: item.unit, value: fields[1], t: Number.isFinite(ts) ? issTimestampMs(ts, nowMs) : nowMs, verified: item.verified };
}

/** Latest numeric value of an item with the time of that value (ms). */
export interface IssSample {
  v: number;
  t: number;
}

const wrap360 = (deg: number): number => ((deg % 360) + 360) % 360;

/**
 * Structured array telemetry from the latest item values, or undefined when no SARJ value is known yet (then nothing
 * can be shown live). Angles are wrapped into 0..360; the attitude quaternion is used only when all four components are
 * present and its norm is within 2% of 1 (it is normalised).
 */
export function buildIssArrays(values: ReadonlyMap<string, IssSample>): IssArrays | undefined {
  const sarj: IssArrays['sarj'] = {};
  const bgaOut: IssArrays['bga'] = {};
  const q: Partial<Record<'w' | 'x' | 'y' | 'z', number>> = {};
  let t = 0;
  for (const item of ISS_ITEMS) {
    const s = values.get(item.id);
    if (!s || !Number.isFinite(s.v)) continue;
    const r = item.role;
    if (r.kind === 'sarj') {
      sarj[r.side] = wrap360(s.v);
      t = Math.max(t, s.t);
    } else if (r.kind === 'bga') bgaOut[r.channel] = wrap360(s.v);
    else if (r.kind === 'att') q[r.comp] = s.v;
  }
  if (sarj.port === undefined && sarj.starboard === undefined) return undefined;
  const out: IssArrays = { t, sarj, bga: bgaOut, verified: { ...ISS_VERIFIED } };
  if (q.w !== undefined && q.x !== undefined && q.y !== undefined && q.z !== undefined) {
    const n = Math.hypot(q.w, q.x, q.y, q.z);
    if (Math.abs(n - 1) < 0.02) out.attitude = [q.w / n, q.x / n, q.y / n, q.z / n];
  }
  return out;
}

/** Order of the BGA channels in the message is the shared `ISS_CHANNELS`; this guards that every channel has an item. */
export const BGA_CHANNELS_COVERED = ISS_CHANNELS.every((c) => ISS_ITEMS.some((i) => i.role.kind === 'bga' && i.role.channel === c));

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
      const values = new Map<string, IssSample>();
      let arraysDirty = false;
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
        if (arraysDirty) {
          arraysDirty = false;
          const arrays = buildIssArrays(values);
          if (arrays) ctx.hub.setArrays(arrays);
        }
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
          ctx.health.note = `Lightstreamer ISSLIVE unavailable (${err.message})`;
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
            ctx.health.note = 'Lightstreamer ISSLIVE connected; SARJ angles, attitude quaternion and state vector verified, BGA angles unverified';
            const group = ISS_ITEMS.map((i) => i.id).join('%20');
            ws.send(`control\r\nLS_reqId=1&LS_op=add&LS_subId=1&LS_mode=MERGE&LS_group=${group}&LS_schema=${FIELDS.join('%20')}&LS_data_adapter=DEFAULT&LS_snapshot=true`);
          } else if (cmd === 'U') {
            const [, itemPos, ...payload] = rest;
            const idx = Number(itemPos) - 1;
            if (!ISS_ITEMS[idx]) continue;
            state[idx] = decodeUpdate(state[idx], payload.join(','));
            const p = telemetryPoint(ISS_ITEMS[idx].id, state[idx]);
            if (p) {
              pending.set(p.id, p);
              const v = Number(p.value);
              if (Number.isFinite(v)) {
                values.set(p.id, { v, t: p.t });
                arraysDirty = true;
              }
            }
          } else if (cmd === 'CONERR' || cmd === 'REQERR' || cmd === 'ERROR') {
            end(new Error(`${cmd} ${rest.join(',')}`));
          } else if (cmd === 'END' || cmd === 'LOOP') end();
        }
      });
    });
  },
};
