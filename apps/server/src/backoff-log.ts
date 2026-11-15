import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The backoff record. Every time the server decides to leave an upstream source alone (the request limiter sets a block,
 * or a connector's persistent retry gate in `backoff.ts` closes) one JSON line is appended to `data/backoff-log.jsonl` and
 * one concise line goes to the console. The state that actually enforces the backoff lives in the SQLite store
 * (`limit:<source>`, `backoff:<source>`); this file only records WHY and for how long, so a later manual check
 * (`npm run celestrak:probe`, reading the real Retry-After) can refine the values in `net/limits.ts` and `backoff.ts`.
 * Writing never throws into the request path.
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

export const BACKOFF_LOG_FILE = 'backoff-log.jsonl';
/** when the file passes this size it is renamed to `<file>.1` (replacing the older one) and a new file starts: at most about 2 x this on disk */
export const MAX_LOG_BYTES = 2 * 1024 * 1024;

const hhmm = (iso: string): string => iso.slice(11, 16) + 'Z';

/** The console line for an entry. */
export function describeEntry(e: BackoffEntry): string {
  const t = e.trigger;
  const why = [t.status !== undefined ? `HTTP ${t.status}` : t.networkError ? 'network error' : undefined, t.retryAfter ? `Retry-After ${t.retryAfter}` : undefined].filter(Boolean).join(', ');
  const mins = e.waitMs >= 3_600_000 ? `${Math.round(e.waitMs / 360_000) / 10} h` : e.waitMs >= 60_000 ? `${Math.round(e.waitMs / 6000) / 10} min` : `${Math.round(e.waitMs / 100) / 10} s`;
  return `backoff ${e.source}${e.host && e.host !== e.source ? ` (${e.host})` : ''}: ${why || e.reason} -> wait ${mins} until ${hhmm(e.until)} [${e.origin}${e.blockKind ? `, ${e.blockKind}` : ''}]${e.previous ? ` (was until ${hhmm(e.previous.until)})` : ''}`;
}

export interface BackoffLogOptions {
  maxBytes?: number;
  /** console output; default `console.log`, a warning goes to `console.warn` */
  print?: (line: string) => void;
}

export class BackoffLog {
  private maxBytes: number;
  private print: (line: string) => void;

  constructor(readonly file: string, opts: BackoffLogOptions = {}) {
    this.maxBytes = opts.maxBytes ?? MAX_LOG_BYTES;
    this.print = opts.print ?? ((line) => console.log(line));
  }

  /** Append one entry and print one line. Never throws. */
  write(entry: BackoffEntry): void {
    try {
      this.print(describeEntry(entry));
    } catch { /* a broken sink must not matter */ }
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      if (existsSync(this.file) && statSync(this.file).size >= this.maxBytes) renameSync(this.file, `${this.file}.1`);
      appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
    } catch (err) {
      console.warn(`backoff log: could not write ${this.file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The newest `n` entries (oldest first), from the current file only. Unreadable lines are skipped. */
  recent(n = 50): BackoffEntry[] {
    try {
      const out: BackoffEntry[] = [];
      for (const line of readFileSync(this.file, 'utf8').split('\n').slice(-(n + 1))) {
        if (!line) continue;
        try { out.push(JSON.parse(line) as BackoffEntry); } catch { /* a torn line */ }
      }
      return out.slice(-n);
    } catch {
      return [];
    }
  }
}

let active: BackoffLog | undefined;

/** Install the process-wide log (`main.ts` and the scripts that make requests); `undefined` switches recording off (the default, so tests stay silent). */
export function setBackoffLog(log: BackoffLog | undefined): BackoffLog | undefined {
  active = log;
  return log;
}

export const backoffLogIn = (dataDir: string, opts?: BackoffLogOptions): BackoffLog => new BackoffLog(join(dataDir, BACKOFF_LOG_FILE), opts);

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
