import { beforeEach, describe, expect, test } from 'vitest';

import { ChronoMemoryDatastore } from '../../src';

describe('ChronoMemoryDatastore', () => {
  type TaskKind = 'send-test-task';
  type TaskData = { someField: number };
  type DatastoreOptions = Record<string, unknown>;

  let memoryDatastore = new ChronoMemoryDatastore<DatastoreOptions>();

  beforeEach(() => {
    memoryDatastore = new ChronoMemoryDatastore<DatastoreOptions>();
  });

  describe('schedule', () => {
    test('should successfully schedule a task', async () => {
      const data: TaskData = {
        someField: 123,
      };

      const when = new Date();

      const result = await memoryDatastore.schedule<TaskKind, TaskData>({
        when,
        kind: 'send-test-task',
        data,
        datastoreOptions: {},
      });

      expect(result).toEqual({
        id: '0',
        kind: 'send-test-task',
        status: 'pending',
        data,
        priority: 0,
        idempotencyKey: undefined,
        originalScheduleDate: when,
        scheduledAt: when,
      });
    });

    test('should successfully schedule a task with idempotency key', async () => {
      const data: TaskData = {
        someField: 123,
      };

      const when = new Date();
      const idempotencyKey = 'test-idempotency-key';

      const result = await memoryDatastore.schedule<TaskKind, TaskData>({
        when,
        kind: 'send-test-task',
        data,
        idempotencyKey,
        datastoreOptions: {},
      });

      expect(result).toEqual({
        id: '0',
        kind: 'send-test-task',
        status: 'pending',
        data,
        priority: 0,
        idempotencyKey,
        originalScheduleDate: when,
        scheduledAt: when,
      });
    });

    test('should return existing task with the same idempotency key', async () => {
      const when = new Date();
      const idempotencyKey = 'test-idempotency-key';

      const task1 = await memoryDatastore.schedule<TaskKind, TaskData>({
        when,
        kind: 'send-test-task',
        data: { someField: 123 },
        idempotencyKey,
        datastoreOptions: {},
      });

      const result = await memoryDatastore.schedule<TaskKind, TaskData>({
        when,
        kind: 'send-test-task',
        data: { someField: 456 },
        idempotencyKey,
        datastoreOptions: {},
      });

      expect(result).toEqual(task1);
    });
  });
});
