import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// the server the dev proxy forwards /api and /stream to (EIO_SERVER=localhost:8799 for a second instance)
const server = process.env.EIO_SERVER ?? 'localhost:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': `http://${server}`,
      '/stream': { target: `ws://${server}`, ws: true },
    },
  },
  worker: { format: 'es' },
  build: { chunkSizeWarningLimit: 1200 },
});
