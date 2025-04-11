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
        claimCount: 0,
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
        claimCount: 0,
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
});
