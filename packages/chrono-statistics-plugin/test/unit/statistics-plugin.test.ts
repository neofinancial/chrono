import { Chrono, type Datastore, type StatisticsCollectorDatastore } from '@neofinancial/chrono';
import { beforeEach, describe, expect, test, vitest } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { createStatisticsPlugin, EventStatisticsCollector, PollingStatisticsCollector } from '../../src';

describe('createStatisticsPlugin', () => {
  type TaskData = { someField: number };
  type TaskMapping = {
    'test-task': TaskData;
  };
  type DatastoreOptions = Record<string, unknown>;

  let datastore: Datastore<TaskMapping, DatastoreOptions> & StatisticsCollectorDatastore<TaskMapping>;
  let chrono: Chrono<TaskMapping, DatastoreOptions>;

  beforeEach(() => {
    datastore = mock<Datastore<TaskMapping, DatastoreOptions> & StatisticsCollectorDatastore<TaskMapping>>();
    chrono = new Chrono<TaskMapping, DatastoreOptions>(datastore);
  });

  describe('polling strategy', () => {
    test('creates a plugin with the correct name', () => {
      const plugin = createStatisticsPlugin<TaskMapping>({
        type: 'polling',
        datastore,
      });

      expect(plugin.name).toBe('statistics-collector');
    });

    test('returns a StatisticsPluginAPI with the collector when registered', () => {
      const api = chrono.use(
        createStatisticsPlugin<TaskMapping>({
          type: 'polling',
          datastore,
        }),
      );

      expect(api).toHaveProperty('collector');
      expect(api.collector).toBeInstanceOf(PollingStatisticsCollector);
    });

    test('starts the collector when chrono starts', async () => {
      const api = chrono.use(
        createStatisticsPlugin<TaskMapping>({
          type: 'polling',
          datastore,
        }),
      );

      // Register a task handler so there are task kinds
      chrono.registerTaskHandler({
        kind: 'test-task',
        handler: vitest.fn(),
      });

      const startSpy = vitest.spyOn(api.collector, 'start');
      await chrono.start();

      expect(startSpy).toHaveBeenCalledOnce();
      expect(startSpy).toHaveBeenCalledWith(['test-task']);
    });

    test('stops the collector when chrono stops', async () => {
      const api = chrono.use(
        createStatisticsPlugin<TaskMapping>({
          type: 'polling',
          datastore,
        }),
      );

      const stopSpy = vitest.spyOn(api.collector, 'stop');

      await chrono.start();
      await chrono.stop();

      expect(stopSpy).toHaveBeenCalledOnce();
    });

    test('passes statCollectionIntervalMs configuration to the collector', () => {
      const api = chrono.use(
        createStatisticsPlugin<TaskMapping>({
          type: 'polling',
          datastore,
          statCollectionIntervalMs: 5000,
        }),
      );

      expect(api.collector).toBeInstanceOf(PollingStatisticsCollector);
    });

    test('collector events can be subscribed to', () => {
      const api = chrono.use(
        createStatisticsPlugin<TaskMapping>({
          type: 'polling',
          datastore,
        }),
      );

      const eventHandler = vitest.fn();
      api.collector.on('statisticsCollected', eventHandler);

      expect(api.collector.listenerCount('statisticsCollected')).toBe(1);
    });

    test('throws error if plugin is registered after chrono starts', async () => {
      await chrono.start();

      expect(() =>
        chrono.use(
          createStatisticsPlugin<TaskMapping>({
            type: 'polling',
            datastore,
          }),
        ),
      ).toThrow('Cannot register plugin "statistics-collector" after Chrono has started');
    });
  });

  describe('event-collect strategy', () => {
    test('creates a plugin with the correct name', () => {
      const plugin = createStatisticsPlugin<TaskMapping>({
        type: 'event-collect',
      });

      expect(plugin.name).toBe('statistics-collector');
    });

    test('returns a StatisticsPluginAPI with the collector when registered', () => {
      const api = chrono.use(
        createStatisticsPlugin<TaskMapping>({
          type: 'event-collect',
        }),
      );

      expect(api).toHaveProperty('collector');
      expect(api.collector).toBeInstanceOf(EventStatisticsCollector);
    });

    test('starts the collector when chrono starts', async () => {
      const api = chrono.use(
        createStatisticsPlugin<TaskMapping>({
          type: 'event-collect',
        }),
      );

      // Register a task handler so there are task kinds
      chrono.registerTaskHandler({
        kind: 'test-task',
        handler: vitest.fn(),
      });

      const startSpy = vitest.spyOn(api.collector, 'start');
      await chrono.start();

      expect(startSpy).toHaveBeenCalledOnce();
      expect(startSpy).toHaveBeenCalledWith(['test-task']);
    });

    test('stops the collector when chrono stops', async () => {
      const api = chrono.use(
        createStatisticsPlugin<TaskMapping>({
          type: 'event-collect',
        }),
      );

      const stopSpy = vitest.spyOn(api.collector, 'stop');

      await chrono.start();
      await chrono.stop();

      expect(stopSpy).toHaveBeenCalledOnce();
    });

    test('collector events can be subscribed to', () => {
      const api = chrono.use(
        createStatisticsPlugin<TaskMapping>({
          type: 'event-collect',
        }),
      );

      const eventHandler = vitest.fn();
      api.collector.on('statisticsCollected', eventHandler);

      expect(api.collector.listenerCount('statisticsCollected')).toBe(1);
    });
  });

  describe('type safety', () => {
    test('polling config requires datastore with StatisticsCollectorDatastore interface', () => {
      // This test verifies the TypeScript types at compile time
      // If this compiles, the types are working correctly

      // Valid: datastore implements StatisticsCollectorDatastore
      const validConfig = {
        type: 'polling' as const,
        datastore: datastore, // Has collectStatistics method
      };

      const plugin = createStatisticsPlugin<TaskMapping>(validConfig);
      expect(plugin.name).toBe('statistics-collector');
    });

    test('event-collect config does not require special datastore', () => {
      // This test verifies the TypeScript types at compile time
      // event-collect doesn't need a datastore in the config at all

      const validConfig = {
        type: 'event-collect' as const,
        intervalMs: 5000,
      };

      // This should compile - no datastore required
      const plugin = createStatisticsPlugin<TaskMapping>(validConfig);
      expect(plugin.name).toBe('statistics-collector');
    });
  });
});
