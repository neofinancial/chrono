import { faker } from '@faker-js/faker';
import { TaskStatus } from '@neofinancial/chrono';
import { type Collection, MongoClient, ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vitest } from 'vitest';

import { ChronoMongoDatastore, type TaskDocument } from '../../src/chrono-mongo-datastore';
import { DB_NAME } from '../database-setup';
import { defineTaskFactory } from '../factories/task.factory';

type TaskMapping = {
  test: {
    test: string;
  };
};

const TEST_DB_COLLECTION_NAME = 'test_tasks';
const TEST_CLAIM_STALE_TIMEOUT_MS = 1_000; // 1 second

describe('ChronoMongoDatastore', () => {
  let mongoClient: MongoClient;
  let collection: Collection<TaskDocument<keyof TaskMapping, TaskMapping[keyof TaskMapping]>>;
  let dataStore: ChronoMongoDatastore<TaskMapping>;
  const testTaskFactory = defineTaskFactory<TaskMapping, 'test'>('test', { test: 'test' });

  beforeAll(async () => {
    mongoClient = new MongoClient('mongodb://localhost:27017');
    await mongoClient.connect();

    collection = mongoClient.db(DB_NAME).collection(TEST_DB_COLLECTION_NAME);

    dataStore = new ChronoMongoDatastore({
      collectionName: TEST_DB_COLLECTION_NAME,
    });

    await dataStore.initialize(mongoClient.db(DB_NAME));
  });

  beforeEach(async () => {
    await collection.deleteMany();
  });

  afterAll(async () => {
    await mongoClient.close();
  });

  describe('initialize', () => {
    test('should throw an error if the database connection is already set', async () => {
      await expect(() => dataStore.initialize(mongoClient.db(DB_NAME))).rejects.toThrow(
        'Database connection already set',
      );
    });
  });

  describe('schedule', () => {
    const input = {
      kind: 'test' as const,
      data: { test: 'test' },
      priority: 1,
      when: new Date(),
    };

    describe('when called before initialize', () => {
      test('should allow scheduling a task', async () => {
        const store = new ChronoMongoDatastore({
          collectionName: TEST_DB_COLLECTION_NAME,
        });

        const resultPromise = store.schedule(input);

        await store.initialize(mongoClient.db(DB_NAME));

        await expect(resultPromise).resolves.toEqual(
          expect.objectContaining({
            kind: input.kind,
            status: 'PENDING',
            data: input.data,
          }),
        );
      });
    });

    describe('when called with valid input', () => {
      test('should return task with correct properties', async () => {
        const task = await dataStore.schedule(input);

        expect(task).toEqual(
          expect.objectContaining({
            kind: input.kind,
            status: 'PENDING',
            data: input.data,
            priority: input.priority,
            originalScheduleDate: expect.any(Date),
            scheduledAt: expect.any(Date),
            id: expect.any(String),
            retryCount: 0,
          }),
        );
      });

      test('should store task in the database', async () => {
        const task = await dataStore.schedule(input);

        const storedTask = await collection.findOne({
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
            retryCount: 0,
          }),
        );
      });
    });

    describe('idempotency', () => {
      test('should return existing task if one exists with same idepotency key', async () => {
        const idempotencyKey = faker.string.uuid();
        const input = {
          kind: 'test' as const,
          data: { test: 'test' },
          priority: 1,
          when: new Date(),
          idempotencyKey,
        };

        const task1 = await dataStore.schedule(input);
        const task2 = await dataStore.schedule(input);

        expect(task1).toEqual(task2);
      });
    });
  });

  describe('claim', () => {
    const input = {
      kind: 'test' as const,
      data: { test: 'test' },
      priority: 1,
      when: new Date(Date.now() - 1),
    };

    test('should allow claiming a task before initialize', async () => {
      const store = new ChronoMongoDatastore({
        collectionName: TEST_DB_COLLECTION_NAME,
      });

      const resultPromise = store.claim({
        kind: input.kind,
        claimStaleTimeoutMs: TEST_CLAIM_STALE_TIMEOUT_MS,
      });

      await store.initialize(mongoClient.db(DB_NAME));

      await expect(resultPromise).resolves.toBeUndefined();
    });

    test('should claim task in PENDING state with scheduledAt in the past', async () => {
      const task = await dataStore.schedule({
        ...input,
        when: new Date(Date.now() - 1000),
      });
      const claimedTask = await dataStore.claim({
        kind: input.kind,
        claimStaleTimeoutMs: TEST_CLAIM_STALE_TIMEOUT_MS,
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
      const scheduledTask = await dataStore.schedule(input);

      const claimedTask = await dataStore.claim({
        kind: input.kind,
        claimStaleTimeoutMs: TEST_CLAIM_STALE_TIMEOUT_MS,
      });

      const claimedTaskAgain = await dataStore.claim({
        kind: input.kind,
        claimStaleTimeoutMs: TEST_CLAIM_STALE_TIMEOUT_MS,
      });

      const fakeTimer = vitest.useFakeTimers();
      fakeTimer.setSystemTime(
        new Date((claimedTask?.claimedAt?.getTime() as number) + TEST_CLAIM_STALE_TIMEOUT_MS + 1),
      );

      const claimedTaskAgainAgain = await dataStore.claim({
        kind: input.kind,
        claimStaleTimeoutMs: TEST_CLAIM_STALE_TIMEOUT_MS,
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
      const task1 = await dataStore.schedule(input);
      const task2 = await dataStore.schedule(input);

      const claimedTasks = await Promise.all([
        dataStore.claim({
          kind: input.kind,
          claimStaleTimeoutMs: TEST_CLAIM_STALE_TIMEOUT_MS,
        }),
        dataStore.claim({
          kind: input.kind,
          claimStaleTimeoutMs: TEST_CLAIM_STALE_TIMEOUT_MS,
        }),
        dataStore.claim({
          kind: input.kind,
          claimStaleTimeoutMs: TEST_CLAIM_STALE_TIMEOUT_MS,
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

  describe('collectStatistics', () => {
    const failedTasks = testTaskFactory.buildList(10, { status: TaskStatus.FAILED });
    const completedTasks = testTaskFactory.buildList(9, { status: TaskStatus.COMPLETED });
    const claimablePendingTasks = testTaskFactory.buildList(8, {
      status: TaskStatus.PENDING,
      scheduledAt: faker.date.past(),
    });
    const nonClaimablePendingTasks = testTaskFactory.buildList(7, {
      status: TaskStatus.PENDING,
      scheduledAt: faker.date.future(),
    });
    const claimedTasks = testTaskFactory.buildList(5, {
      status: TaskStatus.CLAIMED,
    });
    test('should return statistics for a given task kind', async () => {
      await Promise.all(
        [...failedTasks, ...completedTasks, ...claimablePendingTasks, ...nonClaimablePendingTasks, ...claimedTasks].map(
          (task) => collection.insertOne({ ...task, _id: new ObjectId(task.id) }),
        ),
      );
      const statistics = await dataStore.collectStatistics({
        taskKinds: ['test' as const],
      });
      expect(statistics).toEqual({
        test: {
          pendingCount: claimablePendingTasks.length,
          failedCount: failedTasks.length,
          claimedCount: claimedTasks.length,
        },
      });
    });
  });
  describe('complete', () => {
    test('should allow completing a task before initialize', async () => {
      const task = await dataStore.schedule({
        kind: 'test',
        data: { test: 'test' },
        priority: 1,
        when: new Date(),
      });

      const store = new ChronoMongoDatastore({
        collectionName: TEST_DB_COLLECTION_NAME,
      });

      const resultPromise = store.complete(task.id);

      await store.initialize(mongoClient.db(DB_NAME));

      await expect(resultPromise).resolves.toEqual(
        expect.objectContaining({
          id: task.id,
          kind: task.kind,
          status: TaskStatus.COMPLETED,
        }),
      );
    });

    test('should mark task as completed', async () => {
      const task = await dataStore.schedule({
        kind: 'test',
        data: { test: 'test' },
        priority: 1,
        when: new Date(),
      });

      const completedTask = await dataStore.complete(task.id);
      const taskDocument = await collection.findOne({
        _id: new ObjectId(task.id),
      });

      expect(taskDocument).toEqual(
        expect.objectContaining({
          kind: task.kind,
          status: TaskStatus.COMPLETED,
          completedAt: expect.any(Date),
        }),
      );
      expect(completedTask).toEqual(
        expect.objectContaining({
          id: task.id,
          kind: task.kind,
          status: TaskStatus.COMPLETED,
          completedAt: expect.any(Date),
        }),
      );
    });

    test('should throw an error if task is not found', async () => {
      const taskId = faker.database.mongodbObjectId();

      await expect(() => dataStore.complete(taskId)).rejects.toThrow(`Task with ID ${taskId} not found`);
    });
  });

  describe('fail', () => {
    test('should allow failing a task before initialize', async () => {
      const task = await dataStore.schedule({
        kind: 'test',
        data: { test: 'test' },
        priority: 1,
        when: new Date(),
      });

      const store = new ChronoMongoDatastore({
        collectionName: TEST_DB_COLLECTION_NAME,
      });

      const resultPromise = store.fail(task.id);

      await store.initialize(mongoClient.db(DB_NAME));

      await expect(resultPromise).resolves.toEqual(
        expect.objectContaining({
          id: task.id,
          kind: task.kind,
          status: TaskStatus.FAILED,
        }),
      );
    });

    test('should mark task as failed', async () => {
      const task = await dataStore.schedule({
        kind: 'test',
        data: { test: 'test' },
        priority: 1,
        when: new Date(),
      });

      const failedTask = await dataStore.fail(task.id);
      const taskDocument = await collection.findOne({
        _id: new ObjectId(task.id),
      });

      expect(taskDocument).toEqual(
        expect.objectContaining({
          kind: task.kind,
          status: TaskStatus.FAILED,
        }),
      );
      expect(failedTask).toEqual(
        expect.objectContaining({
          id: task.id,
          kind: task.kind,
          status: TaskStatus.FAILED,
        }),
      );
    });

    test('should throw an error if task is not found', async () => {
      const taskId = faker.database.mongodbObjectId();

      await expect(() => dataStore.fail(taskId)).rejects.toThrow(`Task with ID ${taskId} not found`);
    });
  });

  describe('retryAt', () => {
    test('should allow retrying a task before initialize', async () => {
      const task = await dataStore.schedule({
        kind: 'test',
        data: { test: 'test' },
        priority: 1,
        when: new Date(),
      });

      const store = new ChronoMongoDatastore({
        collectionName: TEST_DB_COLLECTION_NAME,
      });

      const resultPromise = store.retry(task.id, new Date());

      await store.initialize(mongoClient.db(DB_NAME));

      await expect(resultPromise).resolves.toEqual(
        expect.objectContaining({
          id: task.id,
          kind: task.kind,
          status: TaskStatus.PENDING,
        }),
      );
    });

    test('should retry task', async () => {
      const firstScheduleDate = faker.date.past();
      const secondScheduleDate = faker.date.past();

      const task = await dataStore.schedule({
        kind: 'test',
        data: { test: 'test' },
        priority: 1,
        when: firstScheduleDate,
      });

      expect(task).toEqual(
        expect.objectContaining({
          status: TaskStatus.PENDING,
          retryCount: 0,
          scheduledAt: firstScheduleDate,
          originalScheduleDate: firstScheduleDate,
        }),
      );

      const taskToRetry = await dataStore.retry(task.id, secondScheduleDate);
      const taskDocument = await collection.findOne({
        _id: new ObjectId(task.id),
      });

      expect(taskDocument).toEqual(
        expect.objectContaining({
          kind: task.kind,
          status: TaskStatus.PENDING,
          scheduledAt: secondScheduleDate,
          originalScheduleDate: firstScheduleDate,
          retryCount: 1,
        }),
      );
      expect(taskToRetry).toEqual(
        expect.objectContaining({
          id: task.id,
          kind: task.kind,
          status: TaskStatus.PENDING,
          scheduledAt: secondScheduleDate,
          originalScheduleDate: firstScheduleDate,
          retryCount: 1,
        }),
      );
    });
  });

  describe('delete', () => {
    test('should allow deleting a task before initialize', async () => {
      const task = await dataStore.schedule({
        kind: 'test',
        data: { test: 'test' },
        priority: 1,
        when: new Date(),
      });

      const store = new ChronoMongoDatastore({
        collectionName: TEST_DB_COLLECTION_NAME,
      });

      const resultPromise = store.delete(task.id);

      await store.initialize(mongoClient.db(DB_NAME));

      await expect(resultPromise).resolves.toBeDefined();
    });

    test('deletes task by id removing from datastore', async () => {
      const when = new Date();

      const task = await dataStore.schedule({
        kind: 'test',
        data: { test: 'test' },
        priority: 1,
        when,
      });

      await dataStore.delete(task.id);

      const taskInDB = await collection.findOne({
        _id: new ObjectId(task.id),
      });

      expect(taskInDB).toBeNull();
    });

    test('deletes task by task kind and idempotency key removing from datastore', async () => {
      const when = new Date();

      const task = await dataStore.schedule({
        idempotencyKey: 'test-idempotency-key',
        kind: 'test',
        data: { test: 'test' },
        priority: 1,
        when,
      });

      await dataStore.delete({ kind: task.kind, idempotencyKey: task.idempotencyKey ?? 'undefined' });

      const taskInDB = await collection.findOne({
        _id: new ObjectId(task.id),
      });

      expect(taskInDB).toBeNull();
    });

    test('returns deleted task', async () => {
      const when = new Date();

      const task = await dataStore.schedule({
        kind: 'test',
        data: { test: 'test' },
        priority: 1,
        when,
      });

      const deletedTask = await dataStore.delete(task.id);

      expect(deletedTask).toEqual(task);
    });

    test('throws when attempting to delete a task that is not PENDING', async () => {
      const when = new Date();

      const task = await dataStore.schedule({
        kind: 'test',
        data: { test: 'test' },
        priority: 1,
        when,
      });

      await dataStore.claim({ kind: task.kind, claimStaleTimeoutMs: TEST_CLAIM_STALE_TIMEOUT_MS });

      await expect(dataStore.delete(task.id)).rejects.toThrow(
        `Task with id ${task.id} can not be deleted as it may not exist or it's not in PENDING status.`,
      );
    });

    test('force deletes PENDING task removing from datastore', async () => {
      const when = new Date();

      const task = await dataStore.schedule({
        kind: 'test',
        data: { test: 'test' },
        priority: 1,
        when,
      });

      await dataStore.claim({ kind: task.kind, claimStaleTimeoutMs: TEST_CLAIM_STALE_TIMEOUT_MS });

      await dataStore.delete(task.id, { force: true });

      const taskInDB = await collection.findOne({
        _id: new ObjectId(task.id),
      });

      expect(taskInDB).toBeNull();
    });

    test('noops when force deleting a task that does not exist', async () => {
      await dataStore.delete(new ObjectId().toHexString(), { force: true });
    });
  });
});
