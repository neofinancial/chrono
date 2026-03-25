import { afterEach, beforeEach, describe, expect, test, vitest } from 'vitest';
import { mock } from 'vitest-mock-extended';

import { Chrono } from '../../src/chrono';
import type { Datastore } from '../../src/datastore';
import type { ChronoPlugin } from '../../src/plugins';

type TaskData = { someField: number };
type TaskMapping = {
  'test-task': TaskData;
  'plugin-task': TaskData;
};
type DatastoreOptions = Record<string, unknown>;

describe('Plugins (integration)', () => {
  let mockDatastore: Datastore<TaskMapping, DatastoreOptions>;
  let chrono: Chrono<TaskMapping, DatastoreOptions>;

  beforeEach(() => {
    mockDatastore = mock<Datastore<TaskMapping, DatastoreOptions>>();
    chrono = new Chrono<TaskMapping, DatastoreOptions>(mockDatastore);
  });

  afterEach(() => {
    vitest.resetAllMocks();
  });

  describe('plugin-to-Chrono interaction', () => {
    test('plugin can register a task handler via context.chrono.registerTaskHandler()', () => {
      const handler = vitest.fn();
      const plugin: ChronoPlugin<TaskMapping, DatastoreOptions> = {
        name: 'handler-plugin',
        register(context) {
          context.chrono.registerTaskHandler({
            kind: 'plugin-task',
            handler,
          });
        },
      };

      chrono.use(plugin);

      // Verify by registering the same kind again -- should throw because it's already registered
      expect(() => chrono.registerTaskHandler({ kind: 'plugin-task', handler: vitest.fn() })).toThrow(
        'Handler for task kind already exists',
      );
    });

    test('plugin can register another plugin via context.chrono.use()', () => {
      const innerRegister = vitest.fn();
      const innerPlugin: ChronoPlugin<TaskMapping, DatastoreOptions> = {
        name: 'inner-plugin',
        register: innerRegister,
      };

      const outerPlugin: ChronoPlugin<TaskMapping, DatastoreOptions> = {
        name: 'outer-plugin',
        register(context) {
          context.chrono.use(innerPlugin);
        },
      };

      chrono.use(outerPlugin);

      expect(innerRegister).toHaveBeenCalledOnce();
    });
  });

  describe('lifecycle hooks', () => {
    test('onStart handler fires during chrono.start()', async () => {
      const onStartHandler = vitest.fn();
      const plugin: ChronoPlugin<TaskMapping, DatastoreOptions> = {
        name: 'start-hook-plugin',
        register(context) {
          context.hooks.onStart(onStartHandler);
        },
      };

      chrono.use(plugin);

      expect(onStartHandler).not.toHaveBeenCalled();

      await chrono.start();

      expect(onStartHandler).toHaveBeenCalledOnce();
    });

    test('onStop handler fires during chrono.stop()', async () => {
      const onStopHandler = vitest.fn();
      const plugin: ChronoPlugin<TaskMapping, DatastoreOptions> = {
        name: 'stop-hook-plugin',
        register(context) {
          context.hooks.onStop(onStopHandler);
        },
      };

      chrono.use(plugin);
      await chrono.start();

      expect(onStopHandler).not.toHaveBeenCalled();

      await chrono.stop();

      expect(onStopHandler).toHaveBeenCalledOnce();
    });

    test('onStart handlers across multiple plugins fire in registration order (FIFO)', async () => {
      const callOrder: string[] = [];

      const pluginA: ChronoPlugin<TaskMapping, DatastoreOptions> = {
        name: 'plugin-a',
        register(context) {
          context.hooks.onStart(() => {
            callOrder.push('a');
          });
        },
      };

      const pluginB: ChronoPlugin<TaskMapping, DatastoreOptions> = {
        name: 'plugin-b',
        register(context) {
          context.hooks.onStart(() => {
            callOrder.push('b');
          });
        },
      };

      const pluginC: ChronoPlugin<TaskMapping, DatastoreOptions> = {
        name: 'plugin-c',
        register(context) {
          context.hooks.onStart(() => {
            callOrder.push('c');
          });
        },
      };

      chrono.use(pluginA);
      chrono.use(pluginB);
      chrono.use(pluginC);

      await chrono.start();

      expect(callOrder).toEqual(['a', 'b', 'c']);
    });

    test('onStop handlers across multiple plugins fire in reverse registration order (LIFO)', async () => {
      const callOrder: string[] = [];

      const pluginA: ChronoPlugin<TaskMapping, DatastoreOptions> = {
        name: 'plugin-a',
        register(context) {
          context.hooks.onStop(() => {
            callOrder.push('a');
          });
        },
      };

      const pluginB: ChronoPlugin<TaskMapping, DatastoreOptions> = {
        name: 'plugin-b',
        register(context) {
          context.hooks.onStop(() => {
            callOrder.push('b');
          });
        },
      };

      const pluginC: ChronoPlugin<TaskMapping, DatastoreOptions> = {
        name: 'plugin-c',
        register(context) {
          context.hooks.onStop(() => {
            callOrder.push('c');
          });
        },
      };

      chrono.use(pluginA);
      chrono.use(pluginB);
      chrono.use(pluginC);

      await chrono.start();
      await chrono.stop();

      expect(callOrder).toEqual(['c', 'b', 'a']);
    });

    test('onStart lifecycle context reflects all registered task kinds including those added by plugins', async () => {
      let taskKinds: (keyof TaskMapping)[] = [];

      // Register a handler directly on Chrono
      chrono.registerTaskHandler({
        kind: 'test-task',
        handler: vitest.fn(),
      });

      // Plugin registers another handler and inspects task kinds on start
      const plugin: ChronoPlugin<TaskMapping, DatastoreOptions> = {
        name: 'inspect-plugin',
        register(context) {
          context.chrono.registerTaskHandler({
            kind: 'plugin-task',
            handler: vitest.fn(),
          });

          context.hooks.onStart((ctx) => {
            taskKinds = ctx.getRegisteredTaskKinds();
          });
        },
      };

      chrono.use(plugin);
      await chrono.start();

      expect(taskKinds).toContain('test-task');
      expect(taskKinds).toContain('plugin-task');
      expect(taskKinds).toHaveLength(2);
    });
  });

  describe('edge cases', () => {
    test('plugin with no hooks does not prevent start/stop from succeeding', async () => {
      const plugin: ChronoPlugin<TaskMapping, DatastoreOptions> = {
        name: 'no-hooks-plugin',
        register: vitest.fn(),
      };

      chrono.use(plugin);

      await expect(chrono.start()).resolves.toBeUndefined();
      await expect(chrono.stop()).resolves.toBeUndefined();
    });

    test('plugin that registers a handler for an already-registered kind throws', () => {
      chrono.registerTaskHandler({
        kind: 'test-task',
        handler: vitest.fn(),
      });

      const plugin: ChronoPlugin<TaskMapping, DatastoreOptions> = {
        name: 'duplicate-handler-plugin',
        register(context) {
          context.chrono.registerTaskHandler({
            kind: 'test-task',
            handler: vitest.fn(),
          });
        },
      };

      expect(() => chrono.use(plugin)).toThrow('Handler for task kind already exists');
    });
  });
});
