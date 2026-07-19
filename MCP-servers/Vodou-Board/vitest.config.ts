import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10000,
    pool: 'forks',           // each test file gets its own process; isolates env vars
    poolOptions: {
      forks: {
        singleFork: false,
      },
    },
  },
});
