import type { EventEmitter } from 'node:events';
import type { TaskMappingBase } from '../chrono';
import type { Statistics } from '../datastore';

export interface StatisticsCollector<TaskMapping extends TaskMappingBase>
  extends EventEmitter<StatisticsCollectorEventsMap<TaskMapping>> {
  start(): Promise<void>;
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
export { createStatisticsCollector, type StatisticsCollectorConfiguration } from './create-collector';
