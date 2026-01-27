import { mock } from 'vitest-mock-extended';

import type { Datastore } from '../../../src/datastore';
import { SimpleProcessor } from '../../../src/processors/simple-processor';
import { defineTaskFactory } from '../../factories/task.factory';

// Mock node:timers/promises to use the global setTimeout which works with fake timers
vi.mock('node:timers/promises', () => ({
  setTimeout: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
}));

describe('SimpleProcessor', () => {
  type TaskMapping = {
    'send-test-task': { foo: string };
  };
  type DatastoreOptions = Record<string, unknown>;
  const backoffStrategy = () => 1;
  const handler = vi.fn(async () => Promise.resolve());

  const datastore = mock<Datastore<TaskMapping, DatastoreOptions>>();
  const taskFactory = defineTaskFactory<TaskMapping>('send-test-task', { foo: 'bar' });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  describe('constructor', () => {
    test('should throw an error when the task handler timeout is greater than or equal to the claim stale timeout', () => {
      expect(
        () =>
          new SimpleProcessor(datastore, 'test', handler, backoffStrategy, {
            taskHandlerTimeoutMs: 10_000,
            claimStaleTimeoutMs: 10_000,
          }),
      ).toThrow('Task handler timeout (10000ms) must be less than the claim stale timeout (10000ms)');
    });
    test('should throw an error when the claim interval is greater than or equal to the idle interval', () => {
      expect(
        () =>
          new SimpleProcessor(datastore, 'test', handler, backoffStrategy, {
            claimIntervalMs: 10_000,
            idleIntervalMs: 10_000,
          }),
      ).toThrow('Claim interval (10000ms) must be less than the idle interval (10000ms)');
    });

    test('should create a simple processor successfully', () => {
      const processor = new SimpleProcessor(datastore, 'test', handler, backoffStrategy, {});

      expect(processor).toBeInstanceOf(SimpleProcessor);
    });
  });

  describe('start', () => {
    test('should start the processor successfully and call handler every claimIntervalMs if datastore returns a task', async () => {
      const task = taskFactory.build();
      datastore.claim.mockResolvedValue(task);
      const processor = new SimpleProcessor(datastore, 'test', handler, backoffStrategy, {
        claimIntervalMs: 1000,
      });

      await processor.start();

      // First claim happens immediately
      await vi.advanceTimersByTimeAsync(10);
      expect(datastore.claim).toHaveBeenCalledTimes(1);

      // Second claim after claimIntervalMs (1000ms)
      await vi.advanceTimersByTimeAsync(1000);
      expect(datastore.claim).toHaveBeenCalledTimes(2);

      // Stop the processor - need to advance timers to let it exit
      const stopPromise = processor.stop();
      await vi.advanceTimersByTimeAsync(1000);
      await stopPromise;
    });

    test('should start the processor successfully and call handler every idleIntervalMs if datastore does not returns a task', async () => {
      datastore.claim.mockResolvedValue(undefined);
      const processor = new SimpleProcessor(datastore, 'test', handler, backoffStrategy, {
        claimIntervalMs: 10,
        idleIntervalMs: 1000,
        taskHandlerTimeoutMs: 10,
      });

      await processor.start();

      // First claim happens immediately
      await vi.advanceTimersByTimeAsync(10);
      expect(datastore.claim).toHaveBeenCalledTimes(1);

      // Second claim after idleIntervalMs (1000ms)
      await vi.advanceTimersByTimeAsync(1000);
      expect(datastore.claim).toHaveBeenCalledTimes(2);
      expect(handler).not.toHaveBeenCalled();

      // Stop the processor - need to advance timers to let it exit
      const stopPromise = processor.stop();
      await vi.advanceTimersByTimeAsync(1000);
      await stopPromise;
    });
  });
});
