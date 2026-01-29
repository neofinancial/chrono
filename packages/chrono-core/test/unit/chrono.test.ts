import { faker } from '@faker-js/faker';
import { afterEach, beforeEach, describe, expect, test, vitest } from 'vitest';
import { mock } from 'vitest-mock-extended';

import { Chrono, type TaskMappingBase } from '../../src/chrono';
import { type Datastore, type Task, TaskStatus } from '../../src/datastore';
import type { ChronoPlugin, PluginContext } from '../../src/plugins';
import { SimpleProcessor } from '../../src/processors/simple-processor';

describe('Chrono', () => {
  type TaskData = { someField: number };
  type TaskMapping = {
    'send-test-task': TaskData;
  };
  type DatastoreOptions = Record<string, unknown>;
  const mockDatastore = mock<Datastore<TaskMapping, DatastoreOptions>>();

  const chrono = new Chrono<TaskMapping, DatastoreOptions>(mockDatastore);

  const mockTask: Task<keyof TaskMapping, TaskData> = {
    id: faker.string.nanoid(),
    kind: 'send-test-task',
    status: TaskStatus.PENDING,
    data: { someField: 1 },
    priority: 0,
    idempotencyKey: faker.string.nanoid(),
    originalScheduleDate: faker.date.future(),
    scheduledAt: faker.date.future(),
    retryCount: 0,
  };

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
      mockDatastore.schedule.mockResolvedValueOnce(mockTask);

      const result = await chrono.scheduleTask({
        when: mockTask.scheduledAt,
        kind: mockTask.kind,
        data: mockTask.data,
      });

      expect(result).toEqual(mockTask);
    });

    test('calls datastore.schedule successfully', async () => {
      mockDatastore.schedule.mockResolvedValueOnce(mockTask);

      await chrono.scheduleTask({
        when: mockTask.scheduledAt,
        kind: mockTask.kind,
        data: mockTask.data,
      });

      expect(mockDatastore.schedule).toHaveBeenCalledOnce();
      expect(mockDatastore.schedule).toHaveBeenCalledWith({
        when: mockTask.scheduledAt,
        kind: mockTask.kind,
        data: mockTask.data,
      });
    });
  });

  describe('deleteTask', () => {
    test('calls the datastore to delete a task by id', async () => {
      mockDatastore.delete.mockResolvedValueOnce(mockTask);

      await chrono.deleteTask(mockTask.id);

      expect(mockDatastore.delete).toHaveBeenCalledOnce();
      expect(mockDatastore.delete).toHaveBeenCalledWith(mockTask.id);
    });

    test('returns the deleted task', async () => {
      mockDatastore.delete.mockResolvedValueOnce(mockTask);

      const result = await chrono.deleteTask(mockTask.id);

      expect(result).toEqual(mockTask);
    });
  });

  describe('registerTaskHandler', () => {
    let chronoInstance: Chrono<TaskMapping, DatastoreOptions>;

    beforeEach(() => {
      chronoInstance = new Chrono<TaskMapping, DatastoreOptions>(mockDatastore);
    });

    test('throws an error if the handler for the task kind already exists', () => {
      const mockHandler = vitest.fn();

      chronoInstance.registerTaskHandler({
        kind: 'send-test-task',
        handler: mockHandler,
      });

      expect(() =>
        chronoInstance.registerTaskHandler({
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
        chronoInstance.registerTaskHandler({
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
        chronoInstance.registerTaskHandler({
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

      const result = chronoInstance.registerTaskHandler({
        kind: 'send-test-task',
        handler: mockHandler,
      });

      expect(result).toBeInstanceOf(SimpleProcessor);
    });
  });

  describe('use', () => {
    let chronoInstance: Chrono<TaskMapping, DatastoreOptions>;

    beforeEach(() => {
      chronoInstance = new Chrono<TaskMapping, DatastoreOptions>(mockDatastore);
    });

    test('registers a plugin and returns its API', () => {
      const mockApi = { foo: 'bar' };
      const mockPlugin: ChronoPlugin<TaskMapping, typeof mockApi> = {
        name: 'test-plugin',
        register: vitest.fn(() => mockApi),
      };

      const result = chronoInstance.use(mockPlugin);

      expect(result).toBe(mockApi);
      expect(mockPlugin.register).toHaveBeenCalledOnce();
    });

    test('calls register with a plugin context', () => {
      const mockPlugin: ChronoPlugin<TaskMapping, void> = {
        name: 'test-plugin',
        register: vitest.fn(),
      };

      chronoInstance.use(mockPlugin);

      expect(mockPlugin.register).toHaveBeenCalledWith(
        expect.objectContaining({
          getProcessorEvents: expect.any(Function),
          hooks: expect.objectContaining({
            onStart: expect.any(Function),
            onStop: expect.any(Function),
          }),
          chrono: expect.objectContaining({
            getRegisteredTaskKinds: expect.any(Function),
            getDatastore: expect.any(Function),
          }),
        }),
      );
    });

    test('throws an error when registering a plugin after start', async () => {
      const mockPlugin: ChronoPlugin<TaskMapping, void> = {
        name: 'test-plugin',
        register: vitest.fn(),
      };

      await chronoInstance.start();

      expect(() => chronoInstance.use(mockPlugin)).toThrow(
        'Cannot register plugin "test-plugin" after Chrono has started',
      );
    });

    test('allows chaining multiple plugin registrations', () => {
      const mockPlugin1: ChronoPlugin<TaskMapping, void> = {
        name: 'plugin-1',
        register: vitest.fn(),
      };
      const mockPlugin2: ChronoPlugin<TaskMapping, void> = {
        name: 'plugin-2',
        register: vitest.fn(),
      };

      // Note: use() returns the API, not `this`, so chaining with different return types
      // works by calling use() separately
      chronoInstance.use(mockPlugin1);
      chronoInstance.use(mockPlugin2);

      expect(mockPlugin1.register).toHaveBeenCalledOnce();
      expect(mockPlugin2.register).toHaveBeenCalledOnce();
    });
  });

  describe('plugin lifecycle', () => {
    let chronoInstance: Chrono<TaskMapping, DatastoreOptions>;

    beforeEach(() => {
      chronoInstance = new Chrono<TaskMapping, DatastoreOptions>(mockDatastore);
    });

    test('executes plugin onStart hooks when chrono starts', async () => {
      const onStartHook = vitest.fn();
      const mockPlugin: ChronoPlugin<TaskMapping, void> = {
        name: 'test-plugin',
        register: (ctx) => {
          ctx.hooks.onStart(onStartHook);
        },
      };

      chronoInstance.use(mockPlugin);
      await chronoInstance.start();

      expect(onStartHook).toHaveBeenCalledOnce();
    });

    test('executes plugin onStop hooks when chrono stops', async () => {
      const onStopHook = vitest.fn();
      const mockPlugin: ChronoPlugin<TaskMapping, void> = {
        name: 'test-plugin',
        register: (ctx) => {
          ctx.hooks.onStop(onStopHook);
        },
      };

      chronoInstance.use(mockPlugin);
      await chronoInstance.start();
      await chronoInstance.stop();

      expect(onStopHook).toHaveBeenCalledOnce();
    });

    test('executes multiple plugin start hooks in registration order (FIFO)', async () => {
      const callOrder: string[] = [];

      const plugin1: ChronoPlugin<TaskMapping, void> = {
        name: 'plugin-1',
        register: (ctx) => {
          ctx.hooks.onStart(() => callOrder.push('plugin-1'));
        },
      };
      const plugin2: ChronoPlugin<TaskMapping, void> = {
        name: 'plugin-2',
        register: (ctx) => {
          ctx.hooks.onStart(() => callOrder.push('plugin-2'));
        },
      };

      chronoInstance.use(plugin1);
      chronoInstance.use(plugin2);
      await chronoInstance.start();

      expect(callOrder).toEqual(['plugin-1', 'plugin-2']);
    });

    test('executes multiple plugin stop hooks in reverse registration order (LIFO)', async () => {
      const callOrder: string[] = [];

      const plugin1: ChronoPlugin<TaskMapping, void> = {
        name: 'plugin-1',
        register: (ctx) => {
          ctx.hooks.onStop(() => callOrder.push('plugin-1'));
        },
      };
      const plugin2: ChronoPlugin<TaskMapping, void> = {
        name: 'plugin-2',
        register: (ctx) => {
          ctx.hooks.onStop(() => callOrder.push('plugin-2'));
        },
      };

      chronoInstance.use(plugin1);
      chronoInstance.use(plugin2);
      await chronoInstance.start();
      await chronoInstance.stop();

      expect(callOrder).toEqual(['plugin-2', 'plugin-1']);
    });

    test('plugin context provides access to registered task kinds', async () => {
      let capturedTaskKinds: (keyof TaskMapping)[] = [];

      const mockPlugin: ChronoPlugin<TaskMapping, void> = {
        name: 'test-plugin',
        register: (ctx) => {
          ctx.hooks.onStart(() => {
            capturedTaskKinds = ctx.chrono.getRegisteredTaskKinds();
          });
        },
      };

      chronoInstance.registerTaskHandler({
        kind: 'send-test-task',
        handler: vitest.fn(),
      });
      chronoInstance.use(mockPlugin);
      await chronoInstance.start();

      expect(capturedTaskKinds).toEqual(['send-test-task']);
    });

    test('plugin context provides access to datastore', () => {
      let capturedDatastore: unknown;

      const mockPlugin: ChronoPlugin<TaskMapping, void> = {
        name: 'test-plugin',
        register: (ctx) => {
          capturedDatastore = ctx.chrono.getDatastore();
        },
      };

      chronoInstance.use(mockPlugin);

      expect(capturedDatastore).toBe(mockDatastore);
    });
  });
});
