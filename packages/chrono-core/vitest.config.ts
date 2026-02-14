import { defineProject, mergeConfig } from 'vitest/config';
import baseConfig from '../../vitest.base.config.js';

export default mergeConfig(
  baseConfig,
  defineProject({
    test: {
      include: ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts'],
    },
  }),
);
