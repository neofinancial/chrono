import { afterEach, beforeEach, describe, expect, test, vitest } from 'vitest';
import { mock } from 'vitest-mock-extended';

import type { BulkDatastore } from '../../src/bulk-datastore';
import { Chrono, type RegisterTaskHandlerBulkInput, type RegisterTaskHandlerInput } from '../../src/chrono';
import type { Datastore } from '../../src/datastore';
import type { ChronoPlugin } from '../../src/plugins';
import { BulkProcessor } from '../../src/processors/bulk-processor';
import { SimpleProcessor } from '../../src/processors/simple-processor';
import { defineTaskFactory } from '../factories/task.factory';

describe('Chrono', () => {
  type TaskData = { someField: number };
  type TaskMapping = {
    'send-test-task': TaskData;
  };
  type DatastoreOptions = Record<string, unknown>;

  const taskFactory = defineTaskFactory<TaskMapping, 'send-test-task'>('send-test-task', { someField: 1 });

  let mockDatastore: ReturnType<typeof mock<Datastore<TaskMapping, DatastoreOptions>>>;
  let chrono: Chrono<TaskMapping, DatastoreOptions>;

  beforeEach(() => {
    mockDatastore = mock<Datastore<TaskMapping, DatastoreOptions>>();
    chrono = new Chrono<TaskMapping, DatastoreOptions>(mockDatastore);
  });

  afterEach(() => {
    vitest.resetAllMocks();
  });

  describe('start', () => {
    test('emits ready event when chrono is instantiated successfully', async () => {
      const emitSpy = vitest.spyOn(chrono, 'emit');

      await chrono.start();

      expect(emitSpy).toHaveBeenCalledOnce();
      expect(emitSpy).toHaveBeenCalledWith('started', {
        startedAt: expect.any(Date),
      });
    });
  });

  describe('scheduleTask', () => {
    test('schedule a task successfully', async () => {
      const task = taskFactory.build();
      mockDatastore.schedule.mockResolvedValueOnce(task);

      const result = await chrono.scheduleTask({
        when: task.scheduledAt,
        kind: task.kind,
        data: task.data,
      });

      expect(result).toEqual(task);
    });

    test('calls datastore.schedule successfully', async () => {
      const task = taskFactory.build();
      mockDatastore.schedule.mockResolvedValueOnce(task);

      await chrono.scheduleTask({
        when: task.scheduledAt,
        kind: task.kind,
        data: task.data,
      });

      expect(mockDatastore.schedule).toHaveBeenCalledOnce();
      expect(mockDatastore.schedule).toHaveBeenCalledWith({
        when: task.scheduledAt,
        kind: task.kind,
        data: task.data,
      });
    });
  });

  describe('deleteTask', () => {
    test('calls the datastore to delete a task by id', async () => {
      const task = taskFactory.build();
      mockDatastore.delete.mockResolvedValueOnce(task);

      await chrono.deleteTask(task.id);

      expect(mockDatastore.delete).toHaveBeenCalledOnce();
      expect(mockDatastore.delete).toHaveBeenCalledWith(task.id);
    });

    test('returns the deleted task', async () => {
      const task = taskFactory.build();
      mockDatastore.delete.mockResolvedValueOnce(task);

      const result = await chrono.deleteTask(task.id);

      expect(result).toEqual(task);
    });
  });

  describe('registerTaskHandler', () => {
    test('throws an error if the handler for the task kind already exists', () => {
      const mockHandler = vitest.fn();

      chrono.registerTaskHandler({
        kind: 'send-test-task',
        handler: mockHandler,
      });

      expect(() =>
        chrono.registerTaskHandler({
          kind: 'send-test-task',
          handler: mockHandler,
        }),
      ).toThrow('Handler for task kind already exists');
    });

    test('throws an error if the task handler timeout is equal to task claim stale timeout', () => {
      const mockHandler = vitest.fn();
      const mockClaimStaleTimeoutMs = 5_000;
      const mockTaskHandlerTimeoutMs = mockClaimStaleTimeoutMs;

      expect(() =>
        chrono.registerTaskHandler({
          kind: 'send-test-task',
          handler: mockHandler,
          processorConfiguration: {
            taskHandlerTimeoutMs: mockTaskHandlerTimeoutMs,
            claimStaleTimeoutMs: mockClaimStaleTimeoutMs,
          },
        }),
      ).toThrow(
        `Task handler timeout (${mockTaskHandlerTimeoutMs}ms) must be less than the claim stale timeout (${mockClaimStaleTimeoutMs}ms)`,
      );
    });

    test('throws an error if the task handler timeout is greter than task claim stale timeout', () => {
      const mockHandler = vitest.fn();
      const mockClaimStaleTimeoutMs = 1000;
      const mockTaskHandlerTimeoutMs = mockClaimStaleTimeoutMs + 1;

      expect(() =>
        chrono.registerTaskHandler({
          kind: 'send-test-task',
          handler: mockHandler,
          processorConfiguration: {
            taskHandlerTimeoutMs: mockTaskHandlerTimeoutMs,
            claimStaleTimeoutMs: mockClaimStaleTimeoutMs,
          },
        }),
      ).toThrow(
        `Task handler timeout (${mockTaskHandlerTimeoutMs}ms) must be less than the claim stale timeout (${mockClaimStaleTimeoutMs}ms)`,
      );
    });

    test('registers a task handler successfully', () => {
      const mockHandler = vitest.fn();

      const result = chrono.registerTaskHandler({
        kind: 'send-test-task',
        handler: mockHandler,
      });

      expect(result).toBeInstanceOf(SimpleProcessor);
    });

    test('registers a bulk task handler when the datastore supports bulk operations', () => {
      const bulkDatastore = mock<
        Datastore<TaskMapping, DatastoreOptions> & BulkDatastore<TaskMapping, DatastoreOptions>
      >();
      Object.assign(bulkDatastore, {
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
        claimMany: async () => [],
        completeMany: async () => ({ succeeded: [], failed: [] }),
        retryMany: async () => ({ succeeded: [], failed: [] }),
        failMany: async () => ({ succeeded: [], failed: [] }),
      });

      const bulkChrono = new Chrono<TaskMapping, DatastoreOptions, typeof bulkDatastore>(bulkDatastore);

      const result = bulkChrono.registerTaskHandler({
        kind: 'send-test-task',
        handler: vitest.fn(),
        processorConfiguration: { type: 'bulk', batchSize: 10 },
      });

      expect(result).toBeInstanceOf(BulkProcessor);
    });

    test('throws when registering a bulk task handler with a non-bulk datastore', () => {
      const handler = vitest.fn();
      const input: RegisterTaskHandlerBulkInput<'send-test-task', TaskData> = {
        kind: 'send-test-task',
        handler,
        processorConfiguration: { type: 'bulk', batchSize: 10 },
      };

      const registerTaskHandler = chrono.registerTaskHandler.bind(chrono) as (
        input: RegisterTaskHandlerInput<'send-test-task', TaskData>,
      ) => ReturnType<Chrono<TaskMapping, DatastoreOptions>['registerTaskHandler']>;

      expect(() => registerTaskHandler(input)).toThrow(
        'Bulk processor requires a datastore that implements BulkDatastore',
      );
    });
  });

  describe('use', () => {
    test('calls plugin.register()', () => {
      const registerFn = vitest.fn();
      const plugin: ChronoPlugin<TaskMapping, DatastoreOptions> = {
        name: 'test-plugin',
        register: registerFn,
      };

      chrono.use(plugin);

      expect(registerFn).toHaveBeenCalledOnce();
    });

    test('returns the plugin API', () => {
      const pluginApi = { greet: () => 'hello' };
      const plugin: ChronoPlugin<TaskMapping, DatastoreOptions, typeof pluginApi> = {
        name: 'api-plugin',
        register: () => pluginApi,
      };

      const result = chrono.use(plugin);

      expect(result).toBe(pluginApi);
    });

    test('throws when called after start()', async () => {
      await chrono.start();

      const plugin: ChronoPlugin<TaskMapping, DatastoreOptions> = {
        name: 'late-plugin',
        register: vitest.fn(),
      };

      expect(() => chrono.use(plugin)).toThrow('Cannot register plugin "late-plugin" after Chrono has started');
    });
  });
});
