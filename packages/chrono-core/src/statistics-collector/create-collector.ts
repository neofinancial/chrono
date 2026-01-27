import type { TaskMappingBase } from '..';
import type { StatisticsCollectorDatastore } from '../datastore';
import type { StatisticsCollector } from '.';
import { SimpleStatisticsCollector, type SimpleStatisticsCollectorConfiguration } from './simple-collector';

/**
 * Configuration for the statistics collector.
 * @default { type: 'simple' }
 */
export type StatisticsCollectorConfiguration = SimpleStatisticsCollectorConfiguration & { type: 'simple' };

const DEFAULT_CONFIG: StatisticsCollectorConfiguration = {
  type: 'simple',
};

export type CreateStatisticsCollectorInput<TaskMapping extends TaskMappingBase> = {
  statisticsCollectorDatastore: StatisticsCollectorDatastore<TaskMapping>;
  taskKinds: (keyof TaskMapping)[];
  configuration?: StatisticsCollectorConfiguration;
};

export function createStatisticsCollector<TaskMapping extends TaskMappingBase>(
  input: CreateStatisticsCollectorInput<TaskMapping>,
): StatisticsCollector<TaskMapping> {
  const config = input.configuration ?? DEFAULT_CONFIG;

  if (config.type === 'simple') {
    return new SimpleStatisticsCollector<TaskMapping>({
      statisticsCollectorDatastore: input.statisticsCollectorDatastore,
      taskKinds: input.taskKinds,
      configuration: config,
    });
  }

  throw new Error(`Unknown statistics collector type: ${config.type}`);
}
