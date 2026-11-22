import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { nodeListener } from '../relay/src/adapter';
import { createRelay } from '../relay/src/handler';

// Bind address. Unset, Vite binds 'localhost', which Node on Windows resolves to the IPv6 loopback ::1 only, so
// http://127.0.0.1:5173 timed out. 127.0.0.1 answers IPv4 clients, and browsers reach http://localhost:5173 through
// their IPv4 fallback. Loopback only: `host: true` would also expose the dev server (and the /relay plugin) to the LAN.
// EIO_WEB_HOST=0.0.0.0 (or ::) opts in to that.
const host = process.env.EIO_WEB_HOST || '127.0.0.1';

// The stateless upstream relay (apps/relay) mounted on the dev server at /relay, so dev needs no separate process.
// Same origin as the page, so no CORS is needed; the dev server's own origins are allowed too.
function relayPlugin(): Plugin {
  return {
    name: 'eio-relay',
    configureServer(s) {
      // the list is filled from the address the server really got (the port may differ from the configured one)
      const origins: string[] = [];
      s.httpServer?.once('listening', () => {
        const a = s.httpServer?.address();
        if (a && typeof a === 'object') origins.push(`http://localhost:${a.port}`, `http://127.0.0.1:${a.port}`);
      });
      const relay = createRelay({ fetch: (u, i) => fetch(u, i), allowedOrigins: origins });
      s.middlewares.use('/relay', nodeListener(relay));
    },
  };
}

export default defineConfig({
  plugins: [react(), relayPlugin()],
  server: {
    port: 5173,
    host,
  },
  worker: { format: 'es' },
  build: { chunkSizeWarningLimit: 1200 },
});
