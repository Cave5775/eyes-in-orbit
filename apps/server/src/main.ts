import { join } from 'node:path';
import compress from '@fastify/compress';
import cors from '@fastify/cors';
import Fastify from 'fastify';
import { loadLiveTelemetry, registerApi } from './api';
import { ImageryCache } from './imagery';
import { loadConfig, loadDotEnv } from './config';
import { Scheduler, type Connector } from './connector';
import { Credentials } from './credentials';
import { bodies } from './connectors/bodies';
import { celestrak } from './connectors/celestrak';
import { dsn } from './connectors/dsn';
import { flightclub } from './connectors/flightclub';
import { horizons } from './connectors/horizons';
import { issLive } from './connectors/iss-live';
import { issRest } from './connectors/iss-rest';
import { launchlibrary } from './connectors/launchlibrary';
import { snapi } from './connectors/snapi';
import { spacetrack } from './connectors/spacetrack';
import { notam, satnogs, webcastOcr } from './connectors/stubs';
import { Http } from './http';
import { Hub } from './hub';
import { Store } from './store';
import { registerStream } from './ws';

const CONNECTORS: Connector[] = [
  bodies, flightclub, celestrak, launchlibrary, snapi, dsn, horizons, issRest, issLive, spacetrack, satnogs, notam, webcastOcr,
];

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  const store = new Store(join(config.dataDir, 'cache.sqlite'));
  store.prune(30 * 86_400_000);
  const http = new Http(store, { offline: config.offline });
  const hub = new Hub();
  const off = new Set(config.disabledConnectors);
  const unknown = [...off].filter((id) => !CONNECTORS.some((c) => c.id === id));
  if (unknown.length) console.warn(`DISABLED_CONNECTORS: unknown connector id(s) ${unknown.join(', ')}; known: ${CONNECTORS.map((c) => c.id).join(', ')}`);
  for (const id of off) Object.assign(hub.healthOf(id), { status: 'disabled', note: 'DISABLED_CONNECTORS' });
  const scheduler = new Scheduler({ hub, config, store, http }, CONNECTORS.filter((c) => !off.has(c.id)));

  const app = Fastify({ logger: { level: 'warn' } });
  await app.register(cors, { origin: true });
  await app.register(compress, { global: true, threshold: 1024 });
  loadLiveTelemetry(hub, store);
  const credentials = new Credentials(config, store);
  registerApi(app, hub, http, store, {
    credentials,
    onChanged: (ids) => ids.forEach((id) => void scheduler.refresh(id)),
  }, new ImageryCache(join(config.dataDir, 'imagery'), { offline: config.offline }));
  await registerStream(app, hub);

  await app.listen({ port: config.port, host: config.host });
  console.log(`EyesInOrbit server on http://${config.host}:${config.port}${config.offline ? ' (OFFLINE)' : ''}`);
  await scheduler.start();

  const shutdown = async () => {
    scheduler.stop();
    await app.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
