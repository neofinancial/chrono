import { MongoClient, ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vitest } from 'vitest';

import { TaskStatus } from '@neofinancial/chrono-core';
import { ChronoMongoDatastore } from '../../src/chrono-mongo-datastore';
import { DB_NAME } from '../database-setup';

type TaskMapping = {
  test: {
    test: string;
  };
};

const TEST_DB_COLLECTION_NAME = 'test_tasks';
const TEST_CLAIM_STALE_TIMEOUT = 1000; // 1 second

describe('ChronoMongoDatastore', () => {
  let mongoClient: MongoClient;
  let chrono: ChronoMongoDatastore<TaskMapping>;

  beforeAll(async () => {
    mongoClient = new MongoClient('mongodb://localhost:27017');
    await mongoClient.connect();

    chrono = new ChronoMongoDatastore(mongoClient.db(DB_NAME), {
      collectionName: TEST_DB_COLLECTION_NAME,
      claimStaleTimeout: TEST_CLAIM_STALE_TIMEOUT,
    });
  });

  beforeEach(async () => {
    await mongoClient.db(DB_NAME).collection(TEST_DB_COLLECTION_NAME).drop();
  });

  afterAll(async () => {
    await mongoClient.close();
  });

  describe('schedule', () => {
    describe('when called with valid input', () => {
      const input = {
        kind: 'test' as const,
        data: { test: 'test' },
        priority: 1,
        when: new Date(),
      };

      test('should return task with correct properties', async () => {
        const task = await chrono.schedule(input);

        expect(task).toEqual(
          expect.objectContaining({
            kind: input.kind,
            status: 'PENDING',
            data: input.data,
            priority: input.priority,
            originalScheduleDate: expect.any(Date),
            scheduledAt: expect.any(Date),
            id: expect.any(String),
          }),
        );
      });

      test('should store task in the database', async () => {
        const task = await chrono.schedule(input);

        const storedTask = await mongoClient
          .db(DB_NAME)
          .collection(TEST_DB_COLLECTION_NAME)
          .findOne({
            _id: new ObjectId(task.id),
          });

        expect(storedTask).toEqual(
          expect.objectContaining({
            kind: input.kind,
            status: 'PENDING',
            data: input.data,
            priority: input.priority,
            originalScheduleDate: expect.any(Date),
            scheduledAt: expect.any(Date),
          }),
        );
      });
    });
  });

  describe('claim', () => {
    const input = {
      kind: 'test' as const,
      data: { test: 'test' },
      priority: 1,
      when: new Date(),
    };

    test('should claim task in PENDING state with scheduledAt in the past', async () => {
      const task = await chrono.schedule({
        ...input,
        when: new Date(Date.now() - 1000),
      });
      const claimedTask = await chrono.claim({
        kind: input.kind,
      });
      expect(claimedTask).toEqual(
        expect.objectContaining({
          id: task.id,
          kind: task.kind,
          status: 'CLAIMED',
        }),
      );
    });

    test('should claim task in CLAIMED state with claimedAt in the past', async () => {
      const scheduledTask = await chrono.schedule(input);

      const claimedTask = await chrono.claim({
        kind: input.kind,
      });

      const claimedTaskAgain = await chrono.claim({
        kind: input.kind,
      });

      const fakeTimer = vitest.useFakeTimers();
      fakeTimer.setSystemTime(new Date((claimedTask?.claimedAt?.getTime() as number) + TEST_CLAIM_STALE_TIMEOUT + 1));

      const claimedTaskAgainAgain = await chrono.claim({
        kind: input.kind,
      });
      fakeTimer.useRealTimers();

      expect(scheduledTask).toEqual(
        expect.objectContaining({
          status: TaskStatus.PENDING,
        }),
      );
      expect(claimedTask).toEqual(
        expect.objectContaining({
          id: scheduledTask.id,
          kind: scheduledTask.kind,
          status: TaskStatus.CLAIMED,
        }),
      );
      expect(claimedTaskAgain).toBeUndefined();
      expect(claimedTaskAgainAgain).toEqual(
        expect.objectContaining({
          id: scheduledTask.id,
          kind: scheduledTask.kind,
          status: TaskStatus.CLAIMED,
        }),
      );
    });

    test('should only be able to claim 1 task at a time', async () => {
      const task1 = await chrono.schedule(input);
      const task2 = await chrono.schedule(input);

      const claimedTasks = await Promise.all([
        chrono.claim({
          kind: input.kind,
        }),
        chrono.claim({
          kind: input.kind,
        }),
        chrono.claim({
          kind: input.kind,
        }),
      ]);

      expect(claimedTasks.length).toEqual(3);
      expect(claimedTasks.filter(Boolean).length).toEqual(2);

      expect(claimedTasks.find((task) => task?.id === task1.id)).toEqual(
        expect.objectContaining({ id: task1.id, status: TaskStatus.CLAIMED }),
      );
      expect(claimedTasks.find((task) => task?.id === task2.id)).toEqual(
        expect.objectContaining({ id: task2.id, status: TaskStatus.CLAIMED }),
      );
    });
  });
});
