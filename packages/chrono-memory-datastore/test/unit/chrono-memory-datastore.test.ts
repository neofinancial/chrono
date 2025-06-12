import { TaskStatus } from '@neofinancial/chrono-core';
import { beforeEach, describe, expect, test } from 'vitest';

import { ChronoMemoryDatastore } from '../../src/chrono-memory-datastore';

describe('ChronoMemoryDatastore', () => {
  type DatastoreOptions = Record<string, unknown>;
  type TaskMapping = {
    'send-test-task': { someField: number };
    'send-delayed_step-function': { differentField: string };
  };

  let memoryDatastore = new ChronoMemoryDatastore<TaskMapping, DatastoreOptions>();

  beforeEach(() => {
    memoryDatastore = new ChronoMemoryDatastore<TaskMapping, DatastoreOptions>();
  });

  describe('schedule', () => {
    test('should successfully schedule a task', async () => {
      const data: TaskMapping['send-test-task'] = {
        someField: 123,
      };

      const when = new Date();

      const result = await memoryDatastore.schedule({
        when,
        kind: 'send-test-task',
        data,
        datastoreOptions: {},
      });

      expect(result).toEqual({
        id: '0',
        kind: 'send-test-task',
        status: TaskStatus.PENDING,
        data,
        priority: 0,
        idempotencyKey: undefined,
        originalScheduleDate: when,
        scheduledAt: when,
        claimedAt: undefined,
        lastExecutedAt: undefined,
        completedAt: undefined,
        retryCount: 0,
      });
    });

    test('should successfully schedule a task with idempotency key', async () => {
      const data: TaskMapping['send-test-task'] = {
        someField: 123,
      };

      const when = new Date();
      const idempotencyKey = 'test-idempotency-key';

      const result = await memoryDatastore.schedule({
        when,
        kind: 'send-test-task',
        data,
        idempotencyKey,
        datastoreOptions: {},
      });

      expect(result).toEqual({
        id: '0',
        kind: 'send-test-task',
        status: TaskStatus.PENDING,
        data,
        priority: 0,
        idempotencyKey,
        originalScheduleDate: when,
        scheduledAt: when,
        lastExecutedAt: undefined,
        completedAt: undefined,
        retryCount: 0,
      });
    });

    test('should return existing task with the same idempotency key', async () => {
      const when = new Date();
      const idempotencyKey = 'test-idempotency-key';

      const task1 = await memoryDatastore.schedule({
        when,
        kind: 'send-test-task',
        data: { someField: 123 },
        idempotencyKey,
        datastoreOptions: {},
      });

      const result = await memoryDatastore.schedule({
        when,
        kind: 'send-test-task',
        data: { someField: 456 },
        idempotencyKey,
        datastoreOptions: {},
      });

      expect(result).toEqual(task1);
    });
  });

  describe('delete', () => {
    test('returns successfully deleted task and removes from datastore', async () => {
      const when = new Date();
      const idempotencyKey = 'test-idempotency-key';

      const task = await memoryDatastore.schedule({
        when,
        kind: 'send-test-task',
        data: { someField: 123 },
        idempotencyKey,
        datastoreOptions: {},
      });

      const deletedTask = await memoryDatastore.delete(task.id);

      await expect(memoryDatastore.delete(task.id)).rejects.toThrow(
        `Task with id ${task.id} can not be deleted as it may not exist or it's not in PENDING status.`,
      );

      expect(deletedTask).toEqual(task);
    });

    test('deletes task by kind and idempotency key', async () => {
      const when = new Date();
      const idempotencyKey = 'test-idempotency-key';

      const task = await memoryDatastore.schedule({
        when,
        kind: 'send-test-task',
        data: { someField: 123 },
        idempotencyKey,
        datastoreOptions: {},
      });

      const deletedTask = await memoryDatastore.delete({ kind: task.kind, idempotencyKey });

      await expect(memoryDatastore.delete(task.id)).rejects.toThrow(
        `Task with id ${task.id} can not be deleted as it may not exist or it's not in PENDING status.`,
      );

      expect(deletedTask).toEqual(task);
    });

    test('throws when attempting to delete a task that is not PENDING', async () => {
      const when = new Date();
      const idempotencyKey = 'test-idempotency-key';

      const task = await memoryDatastore.schedule({
        when,
        kind: 'send-test-task',
        data: { someField: 123 },
        idempotencyKey,
        datastoreOptions: {},
      });

      await memoryDatastore.claim({ kind: task.kind, claimStaleTimeoutMs: 1000 });

      await expect(memoryDatastore.delete(task.id)).rejects.toThrow(
        `Task with id ${task.id} can not be deleted as it may not exist or it's not in PENDING status.`,
      );
    });

    test('allows force deleting a task that is not PENDING', async () => {
      const when = new Date();
      const idempotencyKey = 'test-idempotency-key';

      const task = await memoryDatastore.schedule({
        when,
        kind: 'send-test-task',
        data: { someField: 123 },
        idempotencyKey,
        datastoreOptions: {},
      });

      await memoryDatastore.claim({ kind: task.kind, claimStaleTimeoutMs: 1000 });

      await memoryDatastore.delete(task.id, { force: true });

      await expect(memoryDatastore.retry(task.id, new Date())).rejects.toThrow(`Task with id ${task.id} not found`);
    });

    test('noops when force deleting a task that does not exist', async () => {
      await memoryDatastore.delete('not-an-id', { force: true });
    });
  });
});
