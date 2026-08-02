import { mock } from 'vitest-mock-extended';
import type { BulkDatastore, Datastore } from '../../../src';
import { createProcessor } from '../../../src/processors';
import { BulkProcessor } from '../../../src/processors/bulk-processor';
import type { ProcessorConfiguration } from '../../../src/processors/create-processor';
import { SimpleProcessor } from '../../../src/processors/simple-processor';

type TaskMapping = {
  test: {
    foo: string;
  };
};

describe('createProcessor', () => {
  const datastore = mock<Datastore<TaskMapping, never>>();
  test('should create a simple processor when no input is provided', () => {
    const processor = createProcessor({
      kind: 'test',
      datastore,
      handler: async () => {},
    });

    expect(processor).toBeInstanceOf(SimpleProcessor);
  });

  test('should create a simple processor when input is provided but no type', () => {
    const processor = createProcessor({
      kind: 'test',
      datastore,
      handler: async () => {},
      configuration: {},
    });

    expect(processor).toBeInstanceOf(SimpleProcessor);
  });

  test('should create a simple processor when input is provided and type is provided', () => {
    const processor = createProcessor({
      kind: 'test',
      datastore,
      handler: async () => {},
      configuration: { type: 'simple' },
    });

    expect(processor).toBeInstanceOf(SimpleProcessor);
  });

  test('should throw an error when an unknown processor type is provided', () => {
    expect(() =>
      createProcessor({
        kind: 'test',
        datastore,
        handler: async () => {},
        configuration: { type: 'unknown' } as unknown as ProcessorConfiguration,
      }),
    ).toThrow('Unknown processor type: unknown');
  });

  test('should create a bulk processor when type is bulk and datastore supports bulk operations', () => {
    const bulkDatastore = mock<Datastore<TaskMapping, never> & BulkDatastore<TaskMapping, never>>();
    Object.assign(bulkDatastore, {
      claimMany: async () => [],
      completeMany: async () => ({ succeeded: [], failed: [] }),
      retryMany: async () => ({ succeeded: [], failed: [] }),
      failMany: async () => ({ succeeded: [], failed: [] }),
    });

    const processor = createProcessor({
      kind: 'test',
      datastore: bulkDatastore,
      handler: async () => {},
      configuration: { type: 'bulk' },
    });

    expect(processor).toBeInstanceOf(BulkProcessor);
  });

  test('should throw when type is bulk but datastore does not support bulk operations', () => {
    expect(() =>
      createProcessor({
        kind: 'test',
        datastore,
        handler: async () => {},
        configuration: { type: 'bulk' },
      }),
    ).toThrow('Bulk processor requires a datastore that implements BulkDatastore');
  });
});
