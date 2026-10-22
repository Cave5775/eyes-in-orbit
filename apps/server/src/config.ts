import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Config {
  host: string;
  port: number;
  ll2Token?: string;
  ll2Base: string;
  dataDir: string;
  /** skip all network access; connectors serve what the SQLite cache holds */
  offline: boolean;
  /** DSN Now XML candidates, tried in order until one parses */
  dsnUrls: string[];
  spacetrackUser?: string;
  satnogsToken?: string;
  webcastUrl?: string;
}

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Load `.env` from the repo root (and cwd) without overriding variables that are already set. */
export function loadDotEnv(): void {
  for (const dir of new Set([REPO_ROOT, process.cwd()])) {
    const file = resolve(dir, '.env');
    if (existsSync(file)) process.loadEnvFile(file);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dsn = env.DSN_URL?.split(',').map((s) => s.trim()).filter(Boolean);
  return {
    host: env.HOST || 'localhost',
    port: Number(env.PORT) || 8787,
    ll2Token: env.LL2_TOKEN || undefined,
    ll2Base: (env.LL2_BASE || 'https://ll.thespacedevs.com/2.2.0').replace(/\/+$/, ''),
    dataDir: resolve(env.DATA_DIR || resolve(REPO_ROOT, 'data')),
    offline: env.OFFLINE === '1' || env.OFFLINE === 'true',
    dsnUrls: dsn?.length ? dsn : ['https://eyes.nasa.gov/dsn/data/dsn.xml', 'https://eyes.nasa.gov/dsn/dsn.xml'],
    spacetrackUser: env.SPACETRACK_USER || undefined,
    satnogsToken: env.SATNOGS_TOKEN || undefined,
    webcastUrl: env.WEBCAST_URL || undefined,
  };
}
