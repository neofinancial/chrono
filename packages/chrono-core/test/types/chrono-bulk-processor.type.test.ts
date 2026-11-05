import { expectTypeOf } from 'vitest';

import type { BulkDatastore } from '../../src/bulk-datastore';
import { Chrono } from '../../src/chrono';
import type { Datastore } from '../../src/datastore';

type TaskMapping = {
  'send-test-task': { foo: string };
};

type DatastoreOptions = Record<string, unknown>;

type BulkDatastoreImpl = Datastore<TaskMapping, DatastoreOptions> & BulkDatastore<TaskMapping, DatastoreOptions>;
type SimpleDatastoreImpl = Datastore<TaskMapping, DatastoreOptions>;

declare const bulkDatastore: BulkDatastoreImpl;
declare const simpleDatastore: SimpleDatastoreImpl;

const bulkChrono = new Chrono<TaskMapping, DatastoreOptions, BulkDatastoreImpl>(bulkDatastore);
const simpleChrono = new Chrono<TaskMapping, DatastoreOptions, SimpleDatastoreImpl>(simpleDatastore);

describe('Chrono bulk processor compile-time guards', () => {
  test('allows bulk processor registration on bulk-capable datastores', () => {
    expectTypeOf(
      bulkChrono.registerTaskHandler({
        kind: 'send-test-task',
        handler: async () => {},
        processorConfiguration: { type: 'bulk', batchSize: 10 },
      }),
    ).not.toBeNever();
  });

  test('allows simple processor registration on any datastore', () => {
    expectTypeOf(
      simpleChrono.registerTaskHandler({
        kind: 'send-test-task',
        handler: async () => {},
      }),
    ).not.toBeNever();

    expectTypeOf(
      bulkChrono.registerTaskHandler({
        kind: 'send-test-task',
        handler: async () => {},
        processorConfiguration: { type: 'simple' },
      }),
    ).not.toBeNever();
  });
});

// @ts-expect-error bulk processor registration requires a bulk-capable datastore
simpleChrono.registerTaskHandler({
  kind: 'send-test-task',
  handler: async () => {},
  processorConfiguration: { type: 'bulk', batchSize: 10 },
});

// @ts-expect-error batchSize is not valid on simple processor configuration
simpleChrono.registerTaskHandler({
  kind: 'send-test-task',
  handler: async () => {},
  processorConfiguration: { type: 'simple', batchSize: 10 },
});
