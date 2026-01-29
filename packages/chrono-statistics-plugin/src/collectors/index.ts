import type EventEmitter from 'node:events';
import type { Statistics, TaskMappingBase } from '@neofinancial/chrono'; // tODO should chrono have statistics types?

/**
 * Interface for statistics collectors.
 * Implementations should extend EventEmitter and emit statistics events.
 */
export interface StatisticsCollector<TaskMapping extends TaskMappingBase>
  extends EventEmitter<StatisticsCollectorEventsMap<TaskMapping>> {
  start(taskKinds: (keyof TaskMapping)[]): Promise<void>;
  stop(): Promise<void>;
}

export const StatisticsCollectorEvents = {
  /** A statistics event has been emitted */
  STATISTICS_COLLECTED: 'statisticsCollected',
  /** An error occurred while collecting statistics */
  STATISTICS_COLLECTED_ERROR: 'statisticsCollectedError',
} as const;

export type StatisticsCollectorEventsMap<TaskMapping extends TaskMappingBase> = {
  [StatisticsCollectorEvents.STATISTICS_COLLECTED]: [{ statistics: Statistics<TaskMapping>; timestamp: Date }];
  [StatisticsCollectorEvents.STATISTICS_COLLECTED_ERROR]: [{ error: unknown; timestamp: Date }];
};

export {
  EventStatisticsCollector,
  type EventStatisticsCollectorConfiguration,
  type EventStatisticsCollectorInput,
  type GetProcessorEventsFn,
} from './event-statistics-collector';
export {
  PollingStatisticsCollector,
  type PollingStatisticsCollectorConfiguration,
  type PollingStatisticsCollectorInput,
} from './polling-statistics-collector';
