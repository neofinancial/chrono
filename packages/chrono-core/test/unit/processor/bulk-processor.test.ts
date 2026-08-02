import { mock } from 'vitest-mock-extended';

import type { BulkDatastore } from '../../../src/bulk-datastore';
import type { Datastore } from '../../../src/datastore';
import { BulkProcessor } from '../../../src/processors/bulk-processor';
import { ProcessorEvents } from '../../../src/processors/events';
import { defineTaskFactory } from '../../factories/task.factory';

vi.mock('node:timers/promises', () => ({
  setTimeout: (ms: number, _value?: unknown, options?: { signal?: AbortSignal }) =>
    new Promise<void>((resolve, reject) => {
      if (options?.signal?.aborted) {
        reject(new Error('Aborted'));
        return;
      }

      const timer = setTimeout(resolve, ms);

      options?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('Aborted'));
      });
    }),
}));

describe('BulkProcessor', () => {
  type TaskMapping = {
    'send-test-task': { foo: string };
  };
  type DatastoreOptions = Record<string, unknown>;

  const backoffStrategy = () => 1_000;
  const handler = vi.fn(async () => Promise.resolve());

  const bulkDatastore = mock<Datastore<TaskMapping, DatastoreOptions> & BulkDatastore<TaskMapping, DatastoreOptions>>();
  const taskFactory = defineTaskFactory<TaskMapping, 'send-test-task'>('send-test-task', { foo: 'bar' });

  beforeEach(() => {
    vi.useFakeTimers();
    bulkDatastore.claimMany.mockResolvedValue([]);
    bulkDatastore.completeMany.mockResolvedValue({ succeeded: [], failed: [] });
    bulkDatastore.retryMany.mockResolvedValue({ succeeded: [], failed: [] });
    bulkDatastore.failMany.mockResolvedValue({ succeeded: [], failed: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  describe('constructor', () => {
    test('should throw an error when the task handler timeout is greater than or equal to the claim stale timeout', () => {
      expect(
        () =>
          new BulkProcessor(bulkDatastore, 'send-test-task', handler, backoffStrategy, {
            taskHandlerTimeoutMs: 10_000,
            claimStaleTimeoutMs: 10_000,
          }),
      ).toThrow('Task handler timeout (10000ms) must be less than the claim stale timeout (10000ms)');
    });

    test('should create a bulk processor successfully', () => {
      const processor = new BulkProcessor(bulkDatastore, 'send-test-task', handler, backoffStrategy, {});

      expect(processor).toBeInstanceOf(BulkProcessor);
    });
  });

  describe('start', () => {
    test('should claim batches on batchIntervalMs regardless of whether tasks were returned', async () => {
      const processor = new BulkProcessor(bulkDatastore, 'send-test-task', handler, backoffStrategy, {
        batchIntervalMs: 1_000,
      });

      await processor.start();

      await vi.advanceTimersByTimeAsync(10);
      expect(bulkDatastore.claimMany).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(bulkDatastore.claimMany).toHaveBeenCalledTimes(2);

      const stopPromise = processor.stop();
      await vi.advanceTimersByTimeAsync(1_000);
      await stopPromise;
    });

    test('should abort batchIntervalMs delay when stop is requested', async () => {
      const processor = new BulkProcessor(bulkDatastore, 'send-test-task', handler, backoffStrategy, {
        batchIntervalMs: 10_000,
      });

      await processor.start();
      await vi.advanceTimersByTimeAsync(10);
      expect(bulkDatastore.claimMany).toHaveBeenCalledTimes(1);

      const stopPromise = processor.stop();
      await vi.advanceTimersByTimeAsync(10);

      await expect(stopPromise).resolves.toBeUndefined();
      expect(bulkDatastore.claimMany).toHaveBeenCalledTimes(1);
    });

    test('should process a claimed batch and complete successful tasks', async () => {
      const task = taskFactory.build({ status: 'CLAIMED' });
      const completedTask = taskFactory.build({ status: 'COMPLETED', id: task.id });

      bulkDatastore.claimMany.mockResolvedValueOnce([task]).mockResolvedValue([]);
      bulkDatastore.completeMany.mockResolvedValueOnce({ succeeded: [completedTask], failed: [] });

      const completedHandler = vi.fn();
      const processor = new BulkProcessor(bulkDatastore, 'send-test-task', handler, backoffStrategy, {
        batchIntervalMs: 1_000,
        taskHandlerTimeoutMs: 1_000,
      });

      processor.on(ProcessorEvents.TASK_CLAIMED, completedHandler);
      processor.on(ProcessorEvents.TASK_COMPLETED, completedHandler);

      await processor.start();
      await vi.advanceTimersByTimeAsync(10);

      expect(handler).toHaveBeenCalledWith(task);
      expect(bulkDatastore.completeMany).toHaveBeenCalledWith([task.id]);
      expect(completedHandler).toHaveBeenCalledTimes(2);

      const stopPromise = processor.stop();
      await vi.advanceTimersByTimeAsync(1_000);
      await stopPromise;
    });

    test('should retry failed handler tasks using retryMany', async () => {
      const task = taskFactory.build({ status: 'CLAIMED', retryCount: 0 });
      const retriedTask = taskFactory.build({
        status: 'PENDING',
        id: task.id,
        retryCount: 1,
        scheduledAt: new Date(Date.now() + 1_000),
      });

      bulkDatastore.claimMany.mockResolvedValueOnce([task]).mockResolvedValue([]);
      handler.mockRejectedValueOnce(new Error('handler failed'));
      bulkDatastore.retryMany.mockResolvedValueOnce({ succeeded: [retriedTask], failed: [] });

      const retryHandler = vi.fn();
      const processor = new BulkProcessor(bulkDatastore, 'send-test-task', handler, backoffStrategy, {
        batchIntervalMs: 1_000,
        taskHandlerTimeoutMs: 1_000,
      });

      processor.on(ProcessorEvents.TASK_RETRY_SCHEDULED, retryHandler);

      await processor.start();
      await vi.advanceTimersByTimeAsync(10);

      expect(bulkDatastore.retryMany).toHaveBeenCalledWith([
        expect.objectContaining({
          taskId: task.id,
          retryAt: expect.any(Date),
        }),
      ]);
      expect(retryHandler).toHaveBeenCalledOnce();

      const stopPromise = processor.stop();
      await vi.advanceTimersByTimeAsync(1_000);
      await stopPromise;
    });

    test('should fail tasks that exceed max retries using failMany', async () => {
      const task = taskFactory.build({ status: 'CLAIMED', retryCount: 5 });
      const failedTask = taskFactory.build({ status: 'FAILED', id: task.id });

      bulkDatastore.claimMany.mockResolvedValueOnce([task]).mockResolvedValue([]);
      handler.mockRejectedValueOnce(new Error('handler failed'));
      bulkDatastore.failMany.mockResolvedValueOnce({ succeeded: [failedTask], failed: [] });

      const failedHandler = vi.fn();
      const processor = new BulkProcessor(bulkDatastore, 'send-test-task', handler, backoffStrategy, {
        batchIntervalMs: 1_000,
        taskHandlerTimeoutMs: 1_000,
        taskHandlerMaxRetries: 5,
      });

      processor.on(ProcessorEvents.TASK_FAILED, failedHandler);

      await processor.start();
      await vi.advanceTimersByTimeAsync(10);

      expect(bulkDatastore.failMany).toHaveBeenCalledWith([task.id]);
      expect(failedHandler).toHaveBeenCalledOnce();

      const stopPromise = processor.stop();
      await vi.advanceTimersByTimeAsync(1_000);
      await stopPromise;
    });

    test('should emit TASK_COMPLETION_FAILURE when completeMany fails for a task', async () => {
      const task = taskFactory.build({ status: 'CLAIMED' });

      bulkDatastore.claimMany.mockResolvedValueOnce([task]).mockResolvedValue([]);
      bulkDatastore.completeMany.mockResolvedValueOnce({
        succeeded: [],
        failed: [{ taskId: task.id, error: new Error('write failed') }],
      });

      const completionFailureHandler = vi.fn();
      const processor = new BulkProcessor(bulkDatastore, 'send-test-task', handler, backoffStrategy, {
        batchIntervalMs: 1_000,
        taskHandlerTimeoutMs: 1_000,
      });

      processor.on(ProcessorEvents.TASK_COMPLETION_FAILURE, completionFailureHandler);

      await processor.start();
      await vi.advanceTimersByTimeAsync(10);

      expect(completionFailureHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          task,
          error: expect.any(Error),
        }),
      );

      const stopPromise = processor.stop();
      await vi.advanceTimersByTimeAsync(1_000);
      await stopPromise;
    });
  });
});
