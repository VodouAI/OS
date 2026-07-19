import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    pool: 'forks',
    // CI runners (ubuntu-latest) are much slower than local dev machines.
    // Module compilation + gateway setup (38 test files forking in parallel)
    // takes 10-15s under load — bump timeouts so slow runners don't flake.
    hookTimeout: 60_000,
    testTimeout: 30_000,
    // Limit fork concurrency to reduce CPU contention between test files.
    // 38 files × unconstrained forks = resource thrash on 2-core runners.
    poolOptions: {
      forks: {
        maxForks: 4,
      },
    },
  },
});
