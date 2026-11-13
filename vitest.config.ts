import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
    // the request limiter (apps/server/src/net) is off by default in tests that fire many requests at once; the limiter and
    // per-connector tests build their own limiters with the real table
    env: { EIO_RATE_LIMITS: 'off' },
  },
});
