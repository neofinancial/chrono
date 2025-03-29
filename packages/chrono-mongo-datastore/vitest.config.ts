import { defineProject, mergeConfig } from 'vitest/config';
import baseConfig from '../../vitest.base.config.js';

export default mergeConfig(
  baseConfig,
  defineProject({
    test: {
      globalSetup: './test/database-setup.ts',
    },
  }),
);
