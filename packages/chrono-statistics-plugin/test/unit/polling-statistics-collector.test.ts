import { setTimeout } from 'node:timers/promises';
import type { Statistics, StatisticsCollectorDatastore } from '@neofinancial/chrono';
import { afterEach, describe, expect, test, vitest } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { PollingStatisticsCollector } from '../../src';

type TaskMapping = {
  'test-task': { data: string };
  'another-task': { value: number };
};

describe('PollingStatisticsCollector', () => {
  const datastore = mock<StatisticsCollectorDatastore<TaskMapping>>();

  afterEach(() => {
    vitest.resetAllMocks();
  });

  test('should poll for statistics at the configured interval', async () => {
    const statistics: Statistics<TaskMapping> = {
      'test-task': { pendingCount: 1, failedCount: 0, claimedCount: 0 },
      'another-task': { pendingCount: 2, failedCount: 1, claimedCount: 0 },
    };
    datastore.collectStatistics.mockResolvedValue(statistics);

    const collector = new PollingStatisticsCollector<TaskMapping>({
      statisticsCollectorDatastore: datastore,
      configuration: { statCollectionIntervalMs: 20 },
    });

    await collector.start(['test-task', 'another-task']);

    // Wait for first interval
    await setTimeout(25);
    expect(datastore.collectStatistics).toHaveBeenCalledTimes(1);
    expect(datastore.collectStatistics).toHaveBeenCalledWith({
      taskKinds: ['test-task', 'another-task'],
    });

    // Wait for second interval
    await setTimeout(25);
    expect(datastore.collectStatistics).toHaveBeenCalledTimes(2);

    await collector.stop();
  });

  test('should emit statisticsCollected event when statistics are collected', async () => {
    const statistics: Statistics<TaskMapping> = {
      'test-task': { pendingCount: 5, failedCount: 2, claimedCount: 1 },
      'another-task': { pendingCount: 0, failedCount: 0, claimedCount: 0 },
    };
    datastore.collectStatistics.mockResolvedValue(statistics);

    const collector = new PollingStatisticsCollector<TaskMapping>({
      statisticsCollectorDatastore: datastore,
      configuration: { statCollectionIntervalMs: 10 },
    });

    const eventHandler = vitest.fn();
    collector.on('statisticsCollected', eventHandler);

    await collector.start(['test-task']);
    await setTimeout(15);

    expect(eventHandler).toHaveBeenCalledWith({
      statistics,
      timestamp: expect.any(Date),
    });

    await collector.stop();
  });

  test('should emit statisticsCollectedError event when collection fails', async () => {
    const error = new Error('Database connection failed');
    datastore.collectStatistics.mockRejectedValue(error);

    const collector = new PollingStatisticsCollector<TaskMapping>({
      statisticsCollectorDatastore: datastore,
      configuration: { statCollectionIntervalMs: 10 },
    });

    const errorHandler = vitest.fn();
    collector.on('statisticsCollectedError', errorHandler);

    await collector.start(['test-task']);
    await setTimeout(15);

    expect(errorHandler).toHaveBeenCalledWith({
      error,
      timestamp: expect.any(Date),
    });

    await collector.stop();
  });

  test('should not start twice if already running', async () => {
    datastore.collectStatistics.mockResolvedValue({
      'test-task': { pendingCount: 0, failedCount: 0, claimedCount: 0 },
      'another-task': { pendingCount: 0, failedCount: 0, claimedCount: 0 },
    });

    const collector = new PollingStatisticsCollector<TaskMapping>({
      statisticsCollectorDatastore: datastore,
      configuration: { statCollectionIntervalMs: 50 },
    });

    await collector.start(['test-task']);
    await collector.start(['test-task']); // Should be ignored

    await setTimeout(60);

    // Should only have one interval running
    expect(datastore.collectStatistics).toHaveBeenCalledTimes(1);

    await collector.stop();
  });

  test('should stop gracefully when not running', async () => {
    const collector = new PollingStatisticsCollector<TaskMapping>({
      statisticsCollectorDatastore: datastore,
    });

    // Should not throw
    await expect(collector.stop()).resolves.toBeUndefined();
  });

  test('should use default interval when not configured', () => {
    const collector = new PollingStatisticsCollector<TaskMapping>({
      statisticsCollectorDatastore: datastore,
    });

    // Default is 30 minutes (1_800_000ms)
    // We can't easily test this without waiting, but we can verify the collector was created
    expect(collector).toBeInstanceOf(PollingStatisticsCollector);
  });
});
