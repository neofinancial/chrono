import { mock } from 'vitest-mock-extended';
import type { StatisticsCollectorDatastore } from '../../../src';
import {
  createStatisticsCollector,
  type StatisticsCollectorConfiguration,
} from '../../../src/statistics-collector/create-collector';
import { SimpleStatisticsCollector } from '../../../src/statistics-collector/simple-collector';

type TaskMapping = {
  test: {
    test: string;
  };
};

describe('createStatisticsCollector', () => {
  const datastore = mock<StatisticsCollectorDatastore<TaskMapping>>();

  test('should create a simple statistics collector if no configuration is provided', () => {
    const collector = createStatisticsCollector({
      statisticsCollectorDatastore: datastore,
      taskKinds: ['test' as const],
    });
    expect(collector).toBeInstanceOf(SimpleStatisticsCollector);
  });

  test('should create a simple statistics collector if configuration is provided', () => {
    const collector = createStatisticsCollector({
      statisticsCollectorDatastore: datastore,
      taskKinds: ['test' as const],
      configuration: { type: 'simple' },
    });
    expect(collector).toBeInstanceOf(SimpleStatisticsCollector);
  });

  test('should throw an error if an unknown configuration is provided', () => {
    expect(() =>
      createStatisticsCollector({
        statisticsCollectorDatastore: datastore,
        taskKinds: ['test' as const],
        configuration: { type: 'unknown' } as unknown as StatisticsCollectorConfiguration,
      }),
    ).toThrow('Unknown statistics collector type: unknown');
  });
});
