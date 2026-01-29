// Re-export datastore types from chrono-core for convenience
export type { Statistics, StatisticsCollectorDatastore } from '@neofinancial/chrono';

// Export collectors
export {
  EventStatisticsCollector,
  type EventStatisticsCollectorConfiguration,
  type EventStatisticsCollectorInput,
  type GetProcessorEventsFn,
  PollingStatisticsCollector,
  type PollingStatisticsCollectorConfiguration,
  type PollingStatisticsCollectorInput,
  type StatisticsCollector,
  StatisticsCollectorEvents,
  type StatisticsCollectorEventsMap,
} from './collectors';

// Export plugin
export {
  createStatisticsPlugin,
  type EventCollectStatisticsConfig,
  type PollingStatisticsConfig,
  type StatisticsPluginAPI,
  type StatisticsPluginConfig,
} from './statistics-plugin';
