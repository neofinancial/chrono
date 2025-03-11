import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
    logHeapUsage: true,
    restoreMocks: true,
    poolOptions: { threads: { singleThread: true } },
    pool: 'threads',
    coverage: {
      reporter: ['lcov', 'text'],
      include: ['src/*'],
    },
  },
});
