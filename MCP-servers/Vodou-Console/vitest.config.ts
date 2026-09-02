import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Each run gets its own CLONED databases — see vitest.globalSetup.ts. Two
    // full runs failed on different files while every one passed standalone;
    // rotating failures are contention on shared state, not flaky tests.
    globalSetup: ['./vitest.globalSetup.ts'],
    // Runs per FILE, inside its fork: hands the real paths back to the few
    // tests whose subject is the live gateway rather than a function.
    setupFiles: ['./vitest.setupFile.ts'],
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
