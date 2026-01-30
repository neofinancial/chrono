import { beforeEach, describe, expect, test, vitest } from 'vitest';
import { mock } from 'vitest-mock-extended';

import type { Datastore } from '../../../src/datastore';
import { ChronoPluginContext } from '../../../src/plugins/plugin-context';
import type { Processor } from '../../../src/processors';

describe('ChronoPluginContext', () => {
  type TaskData = { someField: number };
  type TaskMapping = {
    'test-task': TaskData;
    'another-task': TaskData;
  };
  type DatastoreOptions = Record<string, unknown>;

  let processors: Map<keyof TaskMapping, Processor<keyof TaskMapping, TaskMapping>>;
  let datastore: Datastore<TaskMapping, DatastoreOptions>;
  let context: ChronoPluginContext<TaskMapping, DatastoreOptions>;

  beforeEach(() => {
    processors = new Map();
    datastore = mock<Datastore<TaskMapping, DatastoreOptions>>();

    // Add mock processors
    const mockProcessor1 = mock<Processor<'test-task', TaskMapping>>();
    const mockProcessor2 = mock<Processor<'another-task', TaskMapping>>();
    processors.set('test-task', mockProcessor1);
    processors.set('another-task', mockProcessor2);

    context = new ChronoPluginContext<TaskMapping, DatastoreOptions>(processors, datastore);
  });

  describe('getProcessorEvents', () => {
    test('returns the processor for a registered task kind', () => {
      const processor = context.getProcessorEvents('test-task');

      expect(processor).toBe(processors.get('test-task'));
    });

    test('returns undefined for an unregistered task kind', () => {
      const emptyProcessors = new Map<keyof TaskMapping, Processor<keyof TaskMapping, TaskMapping>>();
      const emptyContext = new ChronoPluginContext<TaskMapping, DatastoreOptions>(emptyProcessors, datastore);

      const processor = emptyContext.getProcessorEvents('test-task');

      expect(processor).toBeUndefined();
    });
  });

  describe('chrono.getRegisteredTaskKinds', () => {
    test('returns an array of registered task kinds', () => {
      const taskKinds = context.chrono.getRegisteredTaskKinds();

      expect(taskKinds).toEqual(['test-task', 'another-task']);
    });

    test('returns an empty array when no processors are registered', () => {
      const emptyProcessors = new Map<keyof TaskMapping, Processor<keyof TaskMapping, TaskMapping>>();
      const emptyContext = new ChronoPluginContext<TaskMapping, DatastoreOptions>(emptyProcessors, datastore);

      const taskKinds = emptyContext.chrono.getRegisteredTaskKinds();

      expect(taskKinds).toEqual([]);
    });
  });

  describe('chrono.getDatastore', () => {
    test('returns the datastore', () => {
      const result = context.chrono.getDatastore();

      expect(result).toBe(datastore);
    });
  });

  describe('hooks.onStart', () => {
    test('registers a start hook', async () => {
      const hook = vitest.fn();

      context.hooks.onStart(hook);
      await context.executeStartHooks();

      expect(hook).toHaveBeenCalledOnce();
    });

    test('executes multiple start hooks in order (FIFO)', async () => {
      const callOrder: number[] = [];
      const hook1 = vitest.fn(() => {
        callOrder.push(1);
      });
      const hook2 = vitest.fn(() => {
        callOrder.push(2);
      });
      const hook3 = vitest.fn(() => {
        callOrder.push(3);
      });

      context.hooks.onStart(hook1);
      context.hooks.onStart(hook2);
      context.hooks.onStart(hook3);
      await context.executeStartHooks();

      expect(callOrder).toEqual([1, 2, 3]);
    });

    test('awaits async hooks', async () => {
      const callOrder: number[] = [];
      const asyncHook = vitest.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        callOrder.push(1);
      });
      const syncHook = vitest.fn(() => {
        callOrder.push(2);
      });

      context.hooks.onStart(asyncHook);
      context.hooks.onStart(syncHook);
      await context.executeStartHooks();

      expect(callOrder).toEqual([1, 2]);
    });
  });

  describe('hooks.onStop', () => {
    test('registers a stop hook', async () => {
      const hook = vitest.fn();

      context.hooks.onStop(hook);
      await context.executeStopHooks();

      expect(hook).toHaveBeenCalledOnce();
    });

    test('executes multiple stop hooks in reverse order (LIFO)', async () => {
      const callOrder: number[] = [];
      const hook1 = vitest.fn(() => {
        callOrder.push(1);
      });
      const hook2 = vitest.fn(() => {
        callOrder.push(2);
      });
      const hook3 = vitest.fn(() => {
        callOrder.push(3);
      });

      context.hooks.onStop(hook1);
      context.hooks.onStop(hook2);
      context.hooks.onStop(hook3);
      await context.executeStopHooks();

      expect(callOrder).toEqual([3, 2, 1]);
    });

    test('awaits async hooks', async () => {
      const callOrder: number[] = [];
      const asyncHook = vitest.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        callOrder.push(1);
      });
      const syncHook = vitest.fn(() => {
        callOrder.push(2);
      });

      context.hooks.onStop(syncHook);
      context.hooks.onStop(asyncHook);
      await context.executeStopHooks();

      // LIFO: asyncHook (registered second) runs first
      expect(callOrder).toEqual([1, 2]);
    });
  });
});
