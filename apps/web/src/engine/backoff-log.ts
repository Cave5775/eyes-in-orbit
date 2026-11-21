/**
 * The backoff record. Every time the engine decides to leave an upstream source alone (the request limiter sets a block, or a
 * connector's persistent retry gate in `backoff.ts` closes) one entry goes into an in-memory ring buffer and one concise line
 * to the console. The state that actually enforces the backoff lives in the store (`limit:<source>`, `backoff:<source>`); this
 * log only records WHY and for how long, so the values in `net/limits.ts` and `backoff.ts` can be refined later. The buffer
 * lives as long as the page or worker. Writing never throws into the request path.
 */
export interface BackoffEntry {
  /** ISO time the decision was made */
  time: string;
  /** limiter source key or gate key, e.g. `celestrak`, `celestrak:stations`, `describe:wikimedia` */
  source: string;
  /** upstream host when known (limiter: the request URL; gate: taken from the error message) */
  host?: string;
  /** which mechanism decided: the request limiter (`limiter`) or a per-source retry gate (`gate`) */
  origin: 'limiter' | 'gate';
  trigger: {
    status?: number;
    /** the Retry-After value as the source sent it (seconds or HTTP date) */
    retryAfter?: string;
    /** X-Rate-Limit-Remaining reached 0 */
    rateLimitExhausted?: boolean;
    networkError?: boolean;
    /** the browser hid the answer behind a bare fetch TypeError (CORS) and the source counts that as an answer */
    opaque?: boolean;
    /** consecutive failures counted when the decision was made */
    failures?: number;
    /** error message (gate) or the free-text reason of a manual block (limiter) */
    note?: string;
  };
  waitMs: number;
  /** ISO time the source is left alone until */
  until: string;
  /** why this wait: `HTTP 429, Retry-After 120 s`, `backoff after 3 failures`, ... */
  reason: string;
  /** limiter only: `rate` (the source said so) or `failure` (our own backoff) */
  blockKind?: 'rate' | 'failure';
  /** the block / gate that was in force before this decision, when there was one */
  previous?: { until: string; failures?: number };
}

/** Entries kept; the oldest are dropped. */
export const MAX_LOG_ENTRIES = 200;

const hhmm = (iso: string): string => iso.slice(11, 16) + 'Z';

/** The console line for an entry. */
export function describeEntry(e: BackoffEntry): string {
  const t = e.trigger;
  const why = [
    t.status !== undefined ? `HTTP ${t.status}` : t.opaque ? 'unreadable (CORS) answer' : t.networkError ? 'network error' : undefined,
    t.retryAfter ? `Retry-After ${t.retryAfter}` : undefined,
  ].filter(Boolean).join(', ');
  const mins = e.waitMs >= 3_600_000 ? `${Math.round(e.waitMs / 360_000) / 10} h` : e.waitMs >= 60_000 ? `${Math.round(e.waitMs / 6000) / 10} min` : `${Math.round(e.waitMs / 100) / 10} s`;
  return `backoff ${e.source}${e.host && e.host !== e.source ? ` (${e.host})` : ''}: ${why || e.reason} -> wait ${mins} until ${hhmm(e.until)} [${e.origin}${e.blockKind ? `, ${e.blockKind}` : ''}]${e.previous ? ` (was until ${hhmm(e.previous.until)})` : ''}`;
}

export interface BackoffLogOptions {
  maxEntries?: number;
  /** console output; default `console.log` */
  print?: (line: string) => void;
}

export class BackoffLog {
  private entries: BackoffEntry[] = [];
  private maxEntries: number;
  private print: (line: string) => void;

  constructor(opts: BackoffLogOptions = {}) {
    this.maxEntries = opts.maxEntries ?? MAX_LOG_ENTRIES;
    this.print = opts.print ?? ((line) => console.log(line));
  }

  /** Keep one entry and print one line. Never throws. */
  write(entry: BackoffEntry): void {
    try {
      this.print(describeEntry(entry));
    } catch { /* a broken sink must not matter */ }
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries);
  }

  /** The newest `n` entries, oldest first. */
  recent(n = 50): BackoffEntry[] {
    return this.entries.slice(-n);
  }
}

let active: BackoffLog | undefined;

/** Install the process-wide log (the engine at startup); `undefined` switches recording off (the default, so tests stay silent). */
export function setBackoffLog(log: BackoffLog | undefined): BackoffLog | undefined {
  active = log;
  return log;
}

export const getBackoffLog = (): BackoffLog | undefined => active;

/** What callers pass: like an entry, but with times as epoch ms. */
export type BackoffInput = Omit<BackoffEntry, 'time' | 'until' | 'previous'> & { until: number; previous?: { until: number; failures?: number } };

/** Record a backoff decision made at `at` (ms). A no-op until `setBackoffLog` was called; never throws. */
export function recordBackoff(input: BackoffInput, at: number = Date.now()): void {
  if (!active) return;
  try {
    const { until, previous, ...rest } = input;
    active.write({ time: new Date(at).toISOString(), ...rest, until: new Date(until).toISOString(), ...(previous ? { previous: { ...previous, until: new Date(previous.until).toISOString() } } : {}) });
  } catch (err) {
    console.warn(`backoff log: ${err instanceof Error ? err.message : String(err)}`);
  }
}
