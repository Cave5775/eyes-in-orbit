import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
      '/stream': { target: 'ws://localhost:8787', ws: true },
    },
  },
  worker: { format: 'es' },
  build: { chunkSizeWarningLimit: 1200 },
});
