import type { ChronoPlugin, PluginContext, StatisticsCollectorDatastore, TaskMappingBase } from '@neofinancial/chrono';
import {
  EventStatisticsCollector,
  type EventStatisticsCollectorConfiguration,
  PollingStatisticsCollector,
  type PollingStatisticsCollectorConfiguration,
  type StatisticsCollector,
} from './collectors';

/**
 * Configuration for polling-based statistics collection.
 * Requires a datastore that implements StatisticsCollectorDatastore.
 */
export interface PollingStatisticsConfig<TaskMapping extends TaskMappingBase>
  extends PollingStatisticsCollectorConfiguration {
  type: 'polling';
  /** The datastore to poll for statistics - must implement StatisticsCollectorDatastore */
  datastore: StatisticsCollectorDatastore<TaskMapping>;
}

/**
 * Configuration for event-based statistics collection.
 * Collects statistics by listening to processor events - no special datastore required.
 */
export interface EventCollectStatisticsConfig extends EventStatisticsCollectorConfiguration {
  type: 'event-collect';
}

/**
 * Configuration for the statistics plugin.
 * Use 'polling' to query the datastore periodically, or 'event-collect' to count processor events.
 */
export type StatisticsPluginConfig<TaskMapping extends TaskMappingBase> =
  | PollingStatisticsConfig<TaskMapping>
  | EventCollectStatisticsConfig;

/**
 * The API returned by the statistics plugin.
 * Provides access to the underlying collector for event subscriptions.
 */
export interface StatisticsPluginAPI<TaskMapping extends TaskMappingBase> {
  /** The underlying statistics collector - use this to subscribe to events */
  collector: StatisticsCollector<TaskMapping>;
}

/**
 * Creates a statistics collector plugin for Chrono using polling strategy.
 * Requires a datastore that implements StatisticsCollectorDatastore.
 *
 * @example
 * ```typescript
 * import { Chrono } from '@neofinancial/chrono';
 * import { createStatisticsPlugin } from '@neofinancial/chrono-statistics-plugin';
 *
 * // Datastore must implement StatisticsCollectorDatastore
 * const chrono = new Chrono(datastore);
 *
 * const statistics = chrono.use(createStatisticsPlugin({
 *   type: 'polling',
 *   datastore: datastore, // Pass the same datastore
 *   intervalMs: 60_000,
 * }));
 *
 * statistics.collector.on('statisticsCollected', ({ statistics }) => {
 *   console.log(statistics);
 * });
 * ```
 */
export function createStatisticsPlugin<TaskMapping extends TaskMappingBase>(
  config: PollingStatisticsConfig<TaskMapping>,
): ChronoPlugin<TaskMapping, StatisticsPluginAPI<TaskMapping>>;

/**
 * Creates a statistics collector plugin for Chrono using event-based collection.
 * Counts statistics by listening to processor events - no special datastore interface required.
 *
 * @example
 * ```typescript
 * import { Chrono } from '@neofinancial/chrono';
 * import { createStatisticsPlugin } from '@neofinancial/chrono-statistics-plugin';
 *
 * const chrono = new Chrono(datastore);
 *
 * const statistics = chrono.use(createStatisticsPlugin({
 *   type: 'event-collect',
 *   intervalMs: 60_000,
 * }));
 *
 * statistics.collector.on('statisticsCollected', ({ statistics }) => {
 *   console.log(statistics);
 * });
 * ```
 */
export function createStatisticsPlugin<TaskMapping extends TaskMappingBase>(
  config: EventCollectStatisticsConfig,
): ChronoPlugin<TaskMapping, StatisticsPluginAPI<TaskMapping>>;

// Implementation
export function createStatisticsPlugin<TaskMapping extends TaskMappingBase>(
  config: StatisticsPluginConfig<TaskMapping>,
): ChronoPlugin<TaskMapping, StatisticsPluginAPI<TaskMapping>> {
  return {
    name: 'statistics-collector',

    register(ctx: PluginContext<TaskMapping>): StatisticsPluginAPI<TaskMapping> {
      if (config.type === 'polling') {
        return registerPollingCollector(ctx, config);
      }

      return registerEventCollector(ctx, config);
    },
  };
}

function registerPollingCollector<TaskMapping extends TaskMappingBase>(
  ctx: PluginContext<TaskMapping>,
  config: PollingStatisticsConfig<TaskMapping>,
): StatisticsPluginAPI<TaskMapping> {
  const collector = new PollingStatisticsCollector<TaskMapping>({
    statisticsCollectorDatastore: config.datastore,
    configuration: config,
  });

  ctx.hooks.onStart(async () => {
    const taskKinds = ctx.chrono.getRegisteredTaskKinds();
    await collector.start(taskKinds);
  });

  ctx.hooks.onStop(async () => {
    await collector.stop();
  });

  return { collector };
}

function registerEventCollector<TaskMapping extends TaskMappingBase>(
  ctx: PluginContext<TaskMapping>,
  config: EventCollectStatisticsConfig,
): StatisticsPluginAPI<TaskMapping> {
  const collector = new EventStatisticsCollector<TaskMapping>({
    getProcessorEvents: (kind) => ctx.getProcessorEvents(kind),
    configuration: config,
  });

  ctx.hooks.onStart(async () => {
    const taskKinds = ctx.chrono.getRegisteredTaskKinds();
    await collector.start(taskKinds);
  });

  ctx.hooks.onStop(async () => {
    await collector.stop();
  });

  return { collector };
}
