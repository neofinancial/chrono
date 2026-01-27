import { setTimeout } from 'node:timers/promises';
import { mock } from 'vitest-mock-extended';

import type { Statistics, StatisticsCollectorDatastore } from '../../../src';
import { StatisticsCollectorEvents } from '../../../src/statistics-collector';
import { SimpleStatisticsCollector } from '../../../src/statistics-collector/simple-collector';

type TaskMapping = {
  test: {
    test: string;
  };
};

describe('SimpleStatisticsCollector', () => {
  const datastore = mock<StatisticsCollectorDatastore<TaskMapping>>();

  test('should only collect statistics for the given task kinds', async () => {
    const taskKinds = ['test' as const];
    const statistics: Statistics<TaskMapping> = {
      test: {
        pendingCount: 1,
        failedCount: 1,
        claimedCount: 1,
      },
    };
    datastore.collectStatistics.mockResolvedValue(statistics);
    const collector = new SimpleStatisticsCollector<TaskMapping>({
      statisticsCollectorDatastore: datastore,
      taskKinds: taskKinds,
      configuration: { statCollectionIntervalMs: 10 },
    });

    await collector.start();
    await setTimeout(10);

    expect(datastore.collectStatistics).toHaveBeenCalledTimes(1);

    await setTimeout(10);
    expect(datastore.collectStatistics).toHaveBeenCalledTimes(2);

    await collector.stop();
  });
});
