import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';

import type { Datastore } from '../../../src/datastore';
import { ProcessorEvents } from '../../../src/processors/events';
import { SimpleProcessor } from '../../../src/processors/simple-processor';

describe('SimpleProcessor', () => {
  type TaskMapping = {
    'send-test-task': { foo: string };
  };
  type DatastoreOptions = Record<string, unknown>;

  const datastore = mock<Datastore<TaskMapping, DatastoreOptions>>();

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  describe('statistics interval', () => {
    const claimStaleTimeoutMs = 10000;
    test('emits statisticsCollected on interval', async () => {
      datastore.statistics.mockResolvedValue({ claimableTaskCount: 1, failedTaskCount: 0 });

      const processor = new SimpleProcessor(
        datastore,
        'send-test-task',
        vi.fn(async () => {}),
        () => 0,
        {
          maxConcurrency: 0,
          claimIntervalMs: 10,
          idleIntervalMs: 50,
          statCollectionIntervalMs: 100,
          claimStaleTimeoutMs,
        },
      );

      const emitSpy = vi.spyOn(processor, 'emit');

      await processor.start();

      await vi.advanceTimersByTimeAsync(200);

      expect(datastore.statistics).toHaveBeenCalledTimes(2);
      expect(datastore.statistics).toHaveBeenCalledWith({ taskKind: 'send-test-task', claimStaleTimeoutMs });
      expect(emitSpy).toHaveBeenCalledTimes(2);
      expect(emitSpy).toHaveBeenCalledWith(
        ProcessorEvents.STATISTICS_COLLECTED,
        expect.objectContaining({ timestamp: expect.any(Date) }),
      );

      await processor.stop();
    });

    test('emits statisticsCollectedError when statistics fails', async () => {
      const error = new Error('stats failure');
      datastore.statistics.mockRejectedValue(error);

      const processor = new SimpleProcessor(
        datastore,
        'send-test-task',
        vi.fn(async () => {}),
        () => 0,
        {
          maxConcurrency: 0,
          claimIntervalMs: 10,
          idleIntervalMs: 50,
          statCollectionIntervalMs: 100,
        },
      );

      const emitSpy = vi.spyOn(processor, 'emit');

      await processor.start();

      await vi.advanceTimersByTimeAsync(100);

      expect(datastore.statistics).toHaveBeenCalledWith({ taskKind: 'send-test-task', claimStaleTimeoutMs });
      expect(emitSpy).toHaveBeenCalledWith(
        ProcessorEvents.STATISTICS_COLLECTED_ERROR,
        expect.objectContaining({ error, timestamp: expect.any(Date) }),
      );

      await processor.stop();
    });

    test('stops collecting statistics after stop', async () => {
      datastore.statistics.mockResolvedValue({ claimableTaskCount: 1, failedTaskCount: 0 });

      const processor = new SimpleProcessor(
        datastore,
        'send-test-task',
        vi.fn(async () => {}),
        () => 0,
        {
          maxConcurrency: 0,
          claimIntervalMs: 10,
          idleIntervalMs: 50,
          statCollectionIntervalMs: 100,
        },
      );

      await processor.start();

      await vi.advanceTimersByTimeAsync(100);
      expect(datastore.statistics).toHaveBeenCalledTimes(1);

      await processor.stop();

      await vi.advanceTimersByTimeAsync(200);
      expect(datastore.statistics).toHaveBeenCalledTimes(1);
    });
  });
});
