import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
    logHeapUsage: true,
    restoreMocks: true,
    coverage: {
      reporter: ['lcov', 'text'],
      include: ['src/*'],
    },
  },
});
