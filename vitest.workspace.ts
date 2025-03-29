import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  './packages/chrono-core/vitest.config.ts',
  './packages/chrono-memory-datastore/vitest.config.ts',
  './packages/chrono-mongo-datastore/vitest.config.ts',
]);
