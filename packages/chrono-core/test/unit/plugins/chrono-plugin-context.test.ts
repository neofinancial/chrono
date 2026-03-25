import { afterEach, beforeEach, describe, expect, test, vitest } from 'vitest';
import { mock } from 'vitest-mock-extended';

import type { Chrono } from '../../../src/chrono';
import type { Datastore } from '../../../src/datastore';
import { ChronoPluginContext } from '../../../src/plugins/chrono-plugin-context';
import type { PluginLifecycleContext } from '../../../src/plugins/lifecycle-context';
import type { Processor } from '../../../src/processors';

type TaskData = { someField: number };
type TaskMapping = {
  'test-task': TaskData;
  'other-task': TaskData;
};
type DatastoreOptions = Record<string, unknown>;

describe('ChronoPluginContext', () => {
  let mockChrono: Chrono<TaskMapping, DatastoreOptions>;
  let mockDatastore: Datastore<TaskMapping, DatastoreOptions>;
  let processors: Map<keyof TaskMapping, Processor<keyof TaskMapping, TaskMapping>>;
  let pluginContext: ChronoPluginContext<TaskMapping, DatastoreOptions>;

  beforeEach(() => {
    mockChrono = mock<Chrono<TaskMapping, DatastoreOptions>>();
    mockDatastore = mock<Datastore<TaskMapping, DatastoreOptions>>();
    processors = new Map();
    pluginContext = new ChronoPluginContext(mockChrono, processors, mockDatastore);
  });

  afterEach(() => {
    vitest.resetAllMocks();
  });

  describe('chrono delegation', () => {
    test('chrono.registerTaskHandler delegates to the Chrono instance', () => {
      const input = { kind: 'test-task' as const, handler: vitest.fn() };

      pluginContext.chrono.registerTaskHandler(input);

      expect(mockChrono.registerTaskHandler).toHaveBeenCalledOnce();
      expect(mockChrono.registerTaskHandler).toHaveBeenCalledWith(input);
    });

    test('chrono.use delegates to the Chrono instance', () => {
      const plugin = { name: 'test-plugin', register: vitest.fn() };

      pluginContext.chrono.use(plugin);

      expect(mockChrono.use).toHaveBeenCalledOnce();
      expect(mockChrono.use).toHaveBeenCalledWith(plugin);
    });

    test('chrono.scheduleTask delegates to the Chrono instance', async () => {
      const input = {
        kind: 'test-task' as const,
        when: new Date(),
        data: { someField: 1 },
      };

      await pluginContext.chrono.scheduleTask(input);

      expect(mockChrono.scheduleTask).toHaveBeenCalledOnce();
      expect(mockChrono.scheduleTask).toHaveBeenCalledWith(input);
    });

    test('chrono.deleteTask delegates to the Chrono instance', async () => {
      const taskId = 'task-123';

      await pluginContext.chrono.deleteTask(taskId);

      expect(mockChrono.deleteTask).toHaveBeenCalledOnce();
      expect(mockChrono.deleteTask).toHaveBeenCalledWith(taskId);
    });
  });

  describe('hooks.onStart', () => {
    test('registers a start hook handler', async () => {
      const handler = vitest.fn();

      pluginContext.hooks.onStart(handler);
      await pluginContext.executeStartHooks();

      expect(handler).toHaveBeenCalledOnce();
    });
  });

  describe('hooks.onStop', () => {
    test('registers a stop hook handler', async () => {
      const handler = vitest.fn();

      pluginContext.hooks.onStop(handler);
      await pluginContext.executeStopHooks();

      expect(handler).toHaveBeenCalledOnce();
    });
  });

  describe('executeStartHooks', () => {
    test('executes start hooks in FIFO order', async () => {
      const callOrder: number[] = [];

      pluginContext.hooks.onStart(() => {
        callOrder.push(1);
      });
      pluginContext.hooks.onStart(() => {
        callOrder.push(2);
      });
      pluginContext.hooks.onStart(() => {
        callOrder.push(3);
      });

      await pluginContext.executeStartHooks();

      expect(callOrder).toEqual([1, 2, 3]);
    });

    test('passes a PluginLifecycleContext to each handler', async () => {
      let receivedContext: PluginLifecycleContext<TaskMapping> | undefined;

      pluginContext.hooks.onStart((ctx) => {
        receivedContext = ctx;
      });

      await pluginContext.executeStartHooks();

      expect(receivedContext).toBeDefined();
      expect(receivedContext).toHaveProperty('getRegisteredTaskKinds');
      expect(receivedContext).toHaveProperty('getDatastore');
      expect(receivedContext).toHaveProperty('getProcessorEvents');
    });

    test('awaits async handlers', async () => {
      let completed = false;

      pluginContext.hooks.onStart(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        completed = true;
      });

      await pluginContext.executeStartHooks();

      expect(completed).toBe(true);
    });

    test('succeeds when no hooks are registered', async () => {
      await expect(pluginContext.executeStartHooks()).resolves.toBeUndefined();
    });
  });

  describe('executeStopHooks', () => {
    test('executes stop hooks in LIFO order', async () => {
      const callOrder: number[] = [];

      pluginContext.hooks.onStop(() => {
        callOrder.push(1);
      });
      pluginContext.hooks.onStop(() => {
        callOrder.push(2);
      });
      pluginContext.hooks.onStop(() => {
        callOrder.push(3);
      });

      await pluginContext.executeStopHooks();

      expect(callOrder).toEqual([3, 2, 1]);
    });

    test('passes a PluginLifecycleContext to each handler', async () => {
      let receivedContext: PluginLifecycleContext<TaskMapping> | undefined;

      pluginContext.hooks.onStop((ctx) => {
        receivedContext = ctx;
      });

      await pluginContext.executeStopHooks();

      expect(receivedContext).toBeDefined();
      expect(receivedContext).toHaveProperty('getRegisteredTaskKinds');
      expect(receivedContext).toHaveProperty('getDatastore');
      expect(receivedContext).toHaveProperty('getProcessorEvents');
    });

    test('awaits async handlers', async () => {
      let completed = false;

      pluginContext.hooks.onStop(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        completed = true;
      });

      await pluginContext.executeStopHooks();

      expect(completed).toBe(true);
    });

    test('succeeds when no hooks are registered', async () => {
      await expect(pluginContext.executeStopHooks()).resolves.toBeUndefined();
    });
  });

  describe('lifecycle context', () => {
    test('getRegisteredTaskKinds returns keys from the processors map', async () => {
      const mockProcessor = mock<Processor<'test-task', TaskMapping>>();
      processors.set('test-task', mockProcessor);

      let taskKinds: (keyof TaskMapping)[] = [];

      pluginContext.hooks.onStart((ctx) => {
        taskKinds = ctx.getRegisteredTaskKinds();
      });

      await pluginContext.executeStartHooks();

      expect(taskKinds).toEqual(['test-task']);
    });

    test('getRegisteredTaskKinds returns multiple kinds', async () => {
      processors.set('test-task', mock<Processor<'test-task', TaskMapping>>());
      processors.set('other-task', mock<Processor<'other-task', TaskMapping>>());

      let taskKinds: (keyof TaskMapping)[] = [];

      pluginContext.hooks.onStart((ctx) => {
        taskKinds = ctx.getRegisteredTaskKinds();
      });

      await pluginContext.executeStartHooks();

      expect(taskKinds).toEqual(['test-task', 'other-task']);
    });

    test('getRegisteredTaskKinds returns empty array when no processors are registered', async () => {
      let taskKinds: (keyof TaskMapping)[] = [];

      pluginContext.hooks.onStart((ctx) => {
        taskKinds = ctx.getRegisteredTaskKinds();
      });

      await pluginContext.executeStartHooks();

      expect(taskKinds).toEqual([]);
    });

    test('getDatastore returns the datastore instance', async () => {
      let result: unknown;

      pluginContext.hooks.onStart((ctx) => {
        result = ctx.getDatastore();
      });

      await pluginContext.executeStartHooks();

      expect(result).toBe(mockDatastore);
    });

    test('getProcessorEvents returns the processor for a registered kind', async () => {
      const mockProcessor = mock<Processor<'test-task', TaskMapping>>();
      processors.set('test-task', mockProcessor);

      let result: unknown;

      pluginContext.hooks.onStart((ctx) => {
        result = ctx.getProcessorEvents('test-task');
      });

      await pluginContext.executeStartHooks();

      expect(result).toBe(mockProcessor);
    });

    test('getProcessorEvents returns undefined for an unregistered kind', async () => {
      let result: unknown = 'sentinel';

      pluginContext.hooks.onStart((ctx) => {
        result = ctx.getProcessorEvents('test-task');
      });

      await pluginContext.executeStartHooks();

      expect(result).toBeUndefined();
    });
  });
});
