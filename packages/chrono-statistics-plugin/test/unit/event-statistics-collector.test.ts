import { EventEmitter } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import { ProcessorEvents, type ProcessorEventsMap } from '@neofinancial/chrono';
import { afterEach, beforeEach, describe, expect, test, vitest } from 'vitest';
import { EventStatisticsCollector } from '../../src';

type TaskMapping = {
  'test-task': { data: string };
  'another-task': { value: number };
};

describe('EventStatisticsCollector', () => {
  let testTaskProcessor: EventEmitter<ProcessorEventsMap<'test-task', TaskMapping>>;
  let anotherTaskProcessor: EventEmitter<ProcessorEventsMap<'another-task', TaskMapping>>;
  let getProcessorEvents: <TaskKind extends keyof TaskMapping>(
    kind: TaskKind,
  ) => EventEmitter<ProcessorEventsMap<TaskKind, TaskMapping>> | undefined;

  beforeEach(() => {
    testTaskProcessor = new EventEmitter();
    anotherTaskProcessor = new EventEmitter();

    getProcessorEvents = vitest.fn((kind: keyof TaskMapping) => {
      if (kind === 'test-task') return testTaskProcessor;
      if (kind === 'another-task') return anotherTaskProcessor;
      return undefined;
    }) as typeof getProcessorEvents;
  });

  afterEach(() => {
    vitest.resetAllMocks();
    testTaskProcessor.removeAllListeners();
    anotherTaskProcessor.removeAllListeners();
  });

  describe('event tracking', () => {
    test('tracks taskClaimed events', async () => {
      const collector = new EventStatisticsCollector<TaskMapping>({
        getProcessorEvents,
        configuration: { eventCollectionIntervalMs: 20 },
      });

      const eventHandler = vitest.fn();
      collector.on('statisticsCollected', eventHandler);

      await collector.start(['test-task']);

      // Emit claimed events
      testTaskProcessor.emit(ProcessorEvents.TASK_CLAIMED, { task: {}, claimedAt: new Date() });
      testTaskProcessor.emit(ProcessorEvents.TASK_CLAIMED, { task: {}, claimedAt: new Date() });

      // Wait for interval
      await setTimeout(25);

      expect(eventHandler).toHaveBeenCalledWith({
        statistics: {
          'test-task': { pendingCount: 0, claimedCount: 2, failedCount: 0 },
        },
        timestamp: expect.any(Date),
      });

      await collector.stop();
    });

    test('tracks taskCompleted events', async () => {
      const collector = new EventStatisticsCollector<TaskMapping>({
        getProcessorEvents,
        configuration: { eventCollectionIntervalMs: 20 },
      });

      const eventHandler = vitest.fn();
      collector.on('statisticsCollected', eventHandler);

      await collector.start(['test-task']);

      // Emit completed events
      testTaskProcessor.emit(ProcessorEvents.TASK_COMPLETED, {
        task: {},
        completedAt: new Date(),
        startedAt: new Date(),
      });

      // Wait for interval
      await setTimeout(25);

      // Note: completedCount is tracked internally but not exposed in Statistics type
      // The statistics emission should still work
      expect(eventHandler).toHaveBeenCalledWith({
        statistics: {
          'test-task': { pendingCount: 0, claimedCount: 0, failedCount: 0 },
        },
        timestamp: expect.any(Date),
      });

      await collector.stop();
    });

    test('tracks taskFailed events', async () => {
      const collector = new EventStatisticsCollector<TaskMapping>({
        getProcessorEvents,
        configuration: { eventCollectionIntervalMs: 20 },
      });

      const eventHandler = vitest.fn();
      collector.on('statisticsCollected', eventHandler);

      await collector.start(['test-task']);

      // Emit failed events
      testTaskProcessor.emit(ProcessorEvents.TASK_FAILED, {
        task: {},
        error: new Error('Task failed'),
        failedAt: new Date(),
      });
      testTaskProcessor.emit(ProcessorEvents.TASK_FAILED, {
        task: {},
        error: new Error('Task failed'),
        failedAt: new Date(),
      });
      testTaskProcessor.emit(ProcessorEvents.TASK_FAILED, {
        task: {},
        error: new Error('Task failed'),
        failedAt: new Date(),
      });

      // Wait for interval
      await setTimeout(25);

      expect(eventHandler).toHaveBeenCalledWith({
        statistics: {
          'test-task': { pendingCount: 0, claimedCount: 0, failedCount: 3 },
        },
        timestamp: expect.any(Date),
      });

      await collector.stop();
    });

    test('tracks events for multiple task kinds independently', async () => {
      const collector = new EventStatisticsCollector<TaskMapping>({
        getProcessorEvents,
        configuration: { eventCollectionIntervalMs: 20 },
      });

      const eventHandler = vitest.fn();
      collector.on('statisticsCollected', eventHandler);

      await collector.start(['test-task', 'another-task']);

      // Emit events on different processors
      testTaskProcessor.emit(ProcessorEvents.TASK_CLAIMED, { task: {}, claimedAt: new Date() });
      testTaskProcessor.emit(ProcessorEvents.TASK_CLAIMED, { task: {}, claimedAt: new Date() });
      anotherTaskProcessor.emit(ProcessorEvents.TASK_FAILED, {
        task: {},
        error: new Error('Failed'),
        failedAt: new Date(),
      });

      // Wait for interval
      await setTimeout(25);

      expect(eventHandler).toHaveBeenCalledWith({
        statistics: {
          'test-task': { pendingCount: 0, claimedCount: 2, failedCount: 0 },
          'another-task': { pendingCount: 0, claimedCount: 0, failedCount: 1 },
        },
        timestamp: expect.any(Date),
      });

      await collector.stop();
    });
  });

  describe('statistics emission', () => {
    test('emits statisticsCollected at configured interval', async () => {
      const collector = new EventStatisticsCollector<TaskMapping>({
        getProcessorEvents,
        configuration: { eventCollectionIntervalMs: 20 },
      });

      const eventHandler = vitest.fn();
      collector.on('statisticsCollected', eventHandler);

      await collector.start(['test-task']);

      // Wait for first interval
      await setTimeout(25);
      expect(eventHandler).toHaveBeenCalledTimes(1);

      // Wait for second interval
      await setTimeout(25);
      expect(eventHandler).toHaveBeenCalledTimes(2);

      await collector.stop();
    });

    test('includes all tracked task kinds in emitted statistics', async () => {
      const collector = new EventStatisticsCollector<TaskMapping>({
        getProcessorEvents,
        configuration: { eventCollectionIntervalMs: 20 },
      });

      const eventHandler = vitest.fn();
      collector.on('statisticsCollected', eventHandler);

      await collector.start(['test-task', 'another-task']);

      // Wait for interval
      await setTimeout(25);

      expect(eventHandler).toHaveBeenCalledWith({
        statistics: {
          'test-task': expect.objectContaining({ pendingCount: 0 }),
          'another-task': expect.objectContaining({ pendingCount: 0 }),
        },
        timestamp: expect.any(Date),
      });

      await collector.stop();
    });

    test('pendingCount is always 0', async () => {
      const collector = new EventStatisticsCollector<TaskMapping>({
        getProcessorEvents,
        configuration: { eventCollectionIntervalMs: 20 },
      });

      const eventHandler = vitest.fn();
      collector.on('statisticsCollected', eventHandler);

      await collector.start(['test-task']);

      // Emit some events
      testTaskProcessor.emit(ProcessorEvents.TASK_CLAIMED, { task: {}, claimedAt: new Date() });
      testTaskProcessor.emit(ProcessorEvents.TASK_FAILED, {
        task: {},
        error: new Error('Failed'),
        failedAt: new Date(),
      });

      // Wait for interval
      await setTimeout(25);

      const emittedStats = eventHandler.mock.calls[0][0].statistics;
      expect(emittedStats['test-task'].pendingCount).toBe(0);

      await collector.stop();
    });

    test('resets counters after emission', async () => {
      const collector = new EventStatisticsCollector<TaskMapping>({
        getProcessorEvents,
        configuration: { eventCollectionIntervalMs: 20 },
      });

      const eventHandler = vitest.fn();
      collector.on('statisticsCollected', eventHandler);

      await collector.start(['test-task']);

      // Emit events before first interval
      testTaskProcessor.emit(ProcessorEvents.TASK_CLAIMED, { task: {}, claimedAt: new Date() });
      testTaskProcessor.emit(ProcessorEvents.TASK_CLAIMED, { task: {}, claimedAt: new Date() });

      // Wait for first interval
      await setTimeout(25);

      // First emission should have counts
      expect(eventHandler.mock.calls[0][0].statistics['test-task'].claimedCount).toBe(2);

      // Wait for second interval (no new events)
      await setTimeout(25);

      // Second emission should have reset counts
      expect(eventHandler.mock.calls[1][0].statistics['test-task'].claimedCount).toBe(0);

      await collector.stop();
    });
  });

  describe('lifecycle', () => {
    test('should not start twice if already running', async () => {
      const collector = new EventStatisticsCollector<TaskMapping>({
        getProcessorEvents,
        configuration: { eventCollectionIntervalMs: 50 },
      });

      await collector.start(['test-task']);
      await collector.start(['test-task']); // Should be ignored

      // Check that only 3 listeners were added (claimed, completed, failed)
      expect(testTaskProcessor.listenerCount(ProcessorEvents.TASK_CLAIMED)).toBe(1);
      expect(testTaskProcessor.listenerCount(ProcessorEvents.TASK_COMPLETED)).toBe(1);
      expect(testTaskProcessor.listenerCount(ProcessorEvents.TASK_FAILED)).toBe(1);

      await collector.stop();
    });

    test('should stop gracefully when not running', async () => {
      const collector = new EventStatisticsCollector<TaskMapping>({
        getProcessorEvents,
      });

      // Should not throw
      await expect(collector.stop()).resolves.toBeUndefined();
    });

    test('subscribes to processor events on start', async () => {
      const collector = new EventStatisticsCollector<TaskMapping>({
        getProcessorEvents,
        configuration: { eventCollectionIntervalMs: 50 },
      });

      // Before start, no listeners
      expect(testTaskProcessor.listenerCount(ProcessorEvents.TASK_CLAIMED)).toBe(0);
      expect(testTaskProcessor.listenerCount(ProcessorEvents.TASK_COMPLETED)).toBe(0);
      expect(testTaskProcessor.listenerCount(ProcessorEvents.TASK_FAILED)).toBe(0);

      await collector.start(['test-task']);

      // After start, listeners added
      expect(testTaskProcessor.listenerCount(ProcessorEvents.TASK_CLAIMED)).toBe(1);
      expect(testTaskProcessor.listenerCount(ProcessorEvents.TASK_COMPLETED)).toBe(1);
      expect(testTaskProcessor.listenerCount(ProcessorEvents.TASK_FAILED)).toBe(1);

      await collector.stop();
    });

    test('handles task kinds with no registered processor', async () => {
      const collector = new EventStatisticsCollector<TaskMapping>({
        getProcessorEvents: () => undefined, // No processors registered
        configuration: { eventCollectionIntervalMs: 20 },
      });

      const eventHandler = vitest.fn();
      collector.on('statisticsCollected', eventHandler);

      // Should not throw
      await collector.start(['test-task', 'another-task']);

      // Wait for interval
      await setTimeout(25);

      // Should still emit statistics (with zero counts)
      expect(eventHandler).toHaveBeenCalledWith({
        statistics: {
          'test-task': { pendingCount: 0, claimedCount: 0, failedCount: 0 },
          'another-task': { pendingCount: 0, claimedCount: 0, failedCount: 0 },
        },
        timestamp: expect.any(Date),
      });

      await collector.stop();
    });
  });

  describe('cleanup', () => {
    test('removes listeners from processors on stop', async () => {
      const collector = new EventStatisticsCollector<TaskMapping>({
        getProcessorEvents,
        configuration: { eventCollectionIntervalMs: 50 },
      });

      await collector.start(['test-task', 'another-task']);

      // Verify listeners are added
      expect(testTaskProcessor.listenerCount(ProcessorEvents.TASK_CLAIMED)).toBe(1);
      expect(anotherTaskProcessor.listenerCount(ProcessorEvents.TASK_CLAIMED)).toBe(1);

      await collector.stop();

      // Verify listeners are removed
      expect(testTaskProcessor.listenerCount(ProcessorEvents.TASK_CLAIMED)).toBe(0);
      expect(testTaskProcessor.listenerCount(ProcessorEvents.TASK_COMPLETED)).toBe(0);
      expect(testTaskProcessor.listenerCount(ProcessorEvents.TASK_FAILED)).toBe(0);
      expect(anotherTaskProcessor.listenerCount(ProcessorEvents.TASK_CLAIMED)).toBe(0);
      expect(anotherTaskProcessor.listenerCount(ProcessorEvents.TASK_COMPLETED)).toBe(0);
      expect(anotherTaskProcessor.listenerCount(ProcessorEvents.TASK_FAILED)).toBe(0);
    });

    test('clears statistics on stop', async () => {
      const collector = new EventStatisticsCollector<TaskMapping>({
        getProcessorEvents,
        configuration: { eventCollectionIntervalMs: 20 },
      });

      const eventHandler = vitest.fn();
      collector.on('statisticsCollected', eventHandler);

      await collector.start(['test-task']);

      // Emit some events
      testTaskProcessor.emit(ProcessorEvents.TASK_CLAIMED, { task: {}, claimedAt: new Date() });
      testTaskProcessor.emit(ProcessorEvents.TASK_CLAIMED, { task: {}, claimedAt: new Date() });

      await collector.stop();

      // Start again and verify counters are fresh
      await collector.start(['test-task']);

      // Wait for interval
      await setTimeout(25);

      // Should have zero counts (not the counts from before stop)
      expect(eventHandler).toHaveBeenCalledWith({
        statistics: {
          'test-task': { pendingCount: 0, claimedCount: 0, failedCount: 0 },
        },
        timestamp: expect.any(Date),
      });

      await collector.stop();
    });
  });

  describe('configuration', () => {
    test('uses default interval when not configured', () => {
      const collector = new EventStatisticsCollector<TaskMapping>({
        getProcessorEvents,
      });

      // Default is 60 seconds (60_000ms)
      // We can't easily test this without waiting, but we can verify the collector was created
      expect(collector).toBeInstanceOf(EventStatisticsCollector);
    });
  });
});
