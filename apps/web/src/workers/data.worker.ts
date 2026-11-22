import type { FromWorker, ToWorker } from './data.protocol';
import { createDataService } from './data.service';

/**
 * The data worker: the browser data engine (apps/web/src/engine) behind a message port. All upstream calls and all storage
 * (IndexedDB database `eio`) happen here; the host only serves the app and the stateless relay. See `data.protocol.ts` for the
 * messages and `data.service.ts` for what answers them.
 */
const port = self as unknown as DedicatedWorkerGlobalScope;
const env = import.meta.env as Record<string, string | undefined>;

const service = createDataService({
  post: (msg: FromWorker, transfer?: Transferable[]) => port.postMessage(msg, transfer ?? []),
  appBase: new URL(import.meta.env.BASE_URL, self.location.origin).toString(),
  // deployment switches: CelesTrak through the relay if its CORS headers turn out to be missing; OFFLINE for a cache-only run
  config: { celestrakViaRelay: env.VITE_CELESTRAK_VIA_RELAY === '1', offline: env.VITE_OFFLINE === '1' },
  storage: typeof navigator !== 'undefined' ? navigator.storage : undefined,
});

port.onmessage = (ev: MessageEvent<ToWorker>) => service.handle(ev.data);
port.postMessage({ kind: 'ready' } satisfies FromWorker);
