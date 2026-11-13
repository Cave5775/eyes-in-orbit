import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DSN_FEEDS, FEED_CATALOG, credentialConnector, feedInfo } from '../src/lib/feed-catalog';
import { mockHealth } from '../src/mock/generators';

const dir = join(__dirname, '../../server/src/connectors');
const serverIds = readdirSync(dir)
  .filter((f) => f.endsWith('.ts'))
  .flatMap((f) => [...readFileSync(join(dir, f), 'utf8').matchAll(/(?:Connector = |return )\{\s+id: '([a-z][a-z0-9-]*)'/g)].map((m) => m[1]));

describe('feed catalog', () => {
  it('finds the server connector ids', () => {
    expect(serverIds).toEqual(expect.arrayContaining(['celestrak', 'dsn', 'launchlibrary', 'snapi', 'horizons', 'bodies', 'satnogs']));
  });

  it('has an entry for every server connector id', () => {
    for (const id of serverIds) expect(FEED_CATALOG[id], id).toBeDefined();
  });

  it('has an entry for every mock connector id', () => {
    for (const h of mockHealth(0)) expect(FEED_CATALOG[h.id], h.id).toBeDefined();
  });

  it('describes each entry and links only to https pages', () => {
    for (const [id, e] of Object.entries(FEED_CATALOG)) {
      expect(e.name && e.provides && e.source, id).toBeTruthy();
      if (e.link) expect(e.link, id).toMatch(/^https:\/\//);
    }
  });

  it('gives unknown ids a generic entry and knows the DSN ids', () => {
    expect(feedInfo('nope').name).toBe('nope');
    expect([...DSN_FEEDS].every((id) => FEED_CATALOG[id].name === 'Deep Space Network')).toBe(true);
  });
});

describe('credential feeds', () => {
  it('maps the feeds that need a login or key, and the mock alias', () => {
    expect(credentialConnector('spacetrack')).toBe('spacetrack');
    expect(credentialConnector('launchlibrary')).toBe('launchlibrary');
    expect(credentialConnector('launch-library-2')).toBe('launchlibrary');
    expect(credentialConnector('celestrak')).toBeNull();
  });
});
