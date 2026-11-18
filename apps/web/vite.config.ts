import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// the server the dev proxy forwards /api and /stream to (EIO_SERVER=localhost:8799 for a second instance)
const server = process.env.EIO_SERVER ?? 'localhost:8787';

// Bind address. Unset, Vite binds 'localhost', which Node on Windows resolves to the IPv6 loopback ::1 only, so
// http://127.0.0.1:5173 timed out. 127.0.0.1 answers IPv4 clients, and browsers reach http://localhost:5173 through
// their IPv4 fallback. Loopback only, like the server's HOST default: `host: true` would also expose the dev proxy
// to the LAN, and the proxy reaches the server from a loopback socket, past its localhost-only routes
// (credentials, telemetry). EIO_WEB_HOST=0.0.0.0 (or ::) opts in to that.
const host = process.env.EIO_WEB_HOST || '127.0.0.1';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host,
    proxy: {
      '/api': `http://${server}`,
      '/stream': { target: `ws://${server}`, ws: true },
    },
  },
  worker: { format: 'es' },
  build: { chunkSizeWarningLimit: 1200 },
});
