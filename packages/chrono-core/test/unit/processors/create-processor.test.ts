import { mock } from 'vitest-mock-extended';
import type { Datastore } from '../../../src';
import { createProcessor } from '../../../src/processors';
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
});
