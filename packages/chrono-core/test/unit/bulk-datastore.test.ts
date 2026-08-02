import { describe, expect, test } from 'vitest';

import { type BulkDatastore, isBulkDatastore } from '../../src/bulk-datastore';
import type { Datastore } from '../../src/datastore';

describe('isBulkDatastore', () => {
  type TaskMapping = {
    'test-task': { value: number };
  };
  type DatastoreOptions = Record<string, unknown>;

  const baseDatastore = {
    schedule: async () => {
      throw new Error('not implemented');
    },
    delete: async () => undefined,
    claim: async () => undefined,
    retry: async () => {
      throw new Error('not implemented');
    },
    complete: async () => {
      throw new Error('not implemented');
    },
    fail: async () => {
      throw new Error('not implemented');
    },
  } satisfies Datastore<TaskMapping, DatastoreOptions>;

  test('returns false for a datastore without bulk methods', () => {
    expect(isBulkDatastore(baseDatastore)).toBe(false);
  });

  test('returns false when only some bulk methods are present', () => {
    const datastore = {
      ...baseDatastore,
      claimMany: async () => [],
      completeMany: async () => ({ succeeded: [], failed: [] }),
    };

    expect(isBulkDatastore(datastore)).toBe(false);
  });

  test('returns true when all bulk methods are present', () => {
    const datastore = {
      ...baseDatastore,
      claimMany: async () => [],
      completeMany: async () => ({ succeeded: [], failed: [] }),
      retryMany: async () => ({ succeeded: [], failed: [] }),
      failMany: async () => ({ succeeded: [], failed: [] }),
    } satisfies Datastore<TaskMapping, DatastoreOptions> & BulkDatastore<TaskMapping, DatastoreOptions>;

    expect(isBulkDatastore(datastore)).toBe(true);
  });
});
