import { faker } from '@faker-js/faker';
import { TaskStatus } from '@neofinancial/chrono';
import { type Collection, MongoClient, ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vitest } from 'vitest';

import { ChronoMongoDatastore, type TaskDocument } from '../../src/chrono-mongo-datastore';
import { DB_NAME } from '../database-setup';

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

  describe('claimMany', () => {
    const input = {
      kind: 'test' as const,
      data: { test: 'test' },
      priority: 1,
      when: new Date(Date.now() - 1),
    };

    test('returns an empty array when no tasks are claimable', async () => {
      const claimedTasks = await dataStore.claimMany({
        kind: input.kind,
        batchSize: 10,
        claimStaleTimeoutMs: TEST_CLAIM_STALE_TIMEOUT_MS,
      });

      expect(claimedTasks).toEqual([]);
    });

    test('claims up to batchSize tasks ordered by priority then scheduledAt', async () => {
      const lowPriorityTask = await dataStore.schedule({
        ...input,
        priority: 1,
        when: new Date(Date.now() - 3_000),
      });
      const highPriorityTask = await dataStore.schedule({
        ...input,
        priority: 10,
        when: new Date(Date.now() - 2_000),
      });
      await dataStore.schedule({
        ...input,
        priority: 1,
        when: new Date(Date.now() - 1_000),
      });

      const claimedTasks = await dataStore.claimMany({
        kind: input.kind,
        batchSize: 2,
        claimStaleTimeoutMs: TEST_CLAIM_STALE_TIMEOUT_MS,
      });

      expect(claimedTasks).toHaveLength(2);
      expect(claimedTasks[0]?.id).toEqual(highPriorityTask.id);
      expect(claimedTasks[1]?.id).toEqual(lowPriorityTask.id);
      expect(claimedTasks.every((task) => task.status === TaskStatus.CLAIMED)).toEqual(true);

      const claimedDocuments = await collection
        .find({ _id: { $in: claimedTasks.map((task) => new ObjectId(task.id)) } })
        .toArray();

      expect(claimedDocuments.every((document) => document.claimBatchId)).toEqual(true);
      expect(new Set(claimedDocuments.map((document) => document.claimBatchId)).size).toEqual(1);
    });

    test('does not set claimBatchId when using single claim', async () => {
      const task = await dataStore.schedule(input);
      await dataStore.claim({
        kind: input.kind,
        claimStaleTimeoutMs: TEST_CLAIM_STALE_TIMEOUT_MS,
      });

      const taskDocument = await collection.findOne({ _id: new ObjectId(task.id) });

      expect(taskDocument?.claimBatchId).toBeUndefined();
    });

    test('does not double-claim tasks when competing processes call claimMany concurrently', async () => {
      const taskCount = 10;
      const scheduledTasks = await Promise.all(
        Array.from({ length: taskCount }, (_, index) =>
          dataStore.schedule({
            ...input,
            when: new Date(Date.now() - index - 1),
          }),
        ),
      );

      const claimResults = await Promise.all(
        Array.from({ length: 5 }, () =>
          dataStore.claimMany({
            kind: input.kind,
            batchSize: taskCount,
            claimStaleTimeoutMs: TEST_CLAIM_STALE_TIMEOUT_MS,
          }),
        ),
      );

      const allClaimedIds = claimResults.flatMap((tasks) => tasks.map((task) => task.id));

      expect(allClaimedIds.length).toEqual(new Set(allClaimedIds).size);
      expect(new Set(allClaimedIds).size).toEqual(taskCount);

      const claimedDocuments = await collection.find({ status: TaskStatus.CLAIMED }).toArray();

      expect(claimedDocuments).toHaveLength(taskCount);
      expect(claimedDocuments.map((document) => document._id.toHexString()).sort()).toEqual(
        scheduledTasks.map((task) => task.id).sort(),
      );
    });

    test('splits a small task pool across competing claimMany calls without overlap', async () => {
      const task1 = await dataStore.schedule({
        ...input,
        when: new Date(Date.now() - 2),
      });
      const task2 = await dataStore.schedule({
        ...input,
        when: new Date(Date.now() - 1),
      });

      const claimResults = await Promise.all(
        Array.from({ length: 4 }, () =>
          dataStore.claimMany({
            kind: input.kind,
            batchSize: 2,
            claimStaleTimeoutMs: TEST_CLAIM_STALE_TIMEOUT_MS,
          }),
        ),
      );

      const allClaimedIds = claimResults.flatMap((tasks) => tasks.map((task) => task.id));

      expect(allClaimedIds.sort()).toEqual([task1.id, task2.id].sort());
      expect(new Set(allClaimedIds).size).toEqual(allClaimedIds.length);

      const nonEmptyBatches = claimResults.filter((tasks) => tasks.length > 0);
      const claimBatchIds = await Promise.all(
        nonEmptyBatches.map(async (tasks) => {
          const document = await collection.findOne({ _id: new ObjectId(tasks[0]?.id) });
          return document?.claimBatchId;
        }),
      );

      expect(new Set(claimBatchIds).size).toEqual(claimBatchIds.length);
    });
  });

  describe('completeMany', () => {
    test('returns empty result for empty input', async () => {
      await expect(dataStore.completeMany([])).resolves.toEqual({
        succeeded: [],
        failed: [],
      });
    });

    test('completes claimed tasks in bulk', async () => {
      const task = await dataStore.schedule({
        kind: 'test',
        data: { test: 'test' },
        priority: 1,
        when: new Date(Date.now() - 1),
      });

      const [claimedTask] = await dataStore.claimMany({
        kind: 'test',
        batchSize: 1,
        claimStaleTimeoutMs: TEST_CLAIM_STALE_TIMEOUT_MS,
      });

      expect(claimedTask?.id).toEqual(task.id);

      const result = await dataStore.completeMany([task.id]);

      expect(result.failed).toEqual([]);
      expect(result.succeeded).toEqual([
        expect.objectContaining({
          id: task.id,
          status: TaskStatus.COMPLETED,
        }),
      ]);
    });

    test('reports tasks that are not in CLAIMED status as failed', async () => {
      const task = await dataStore.schedule({
        kind: 'test',
        data: { test: 'test' },
        priority: 1,
        when: new Date(),
      });

      const result = await dataStore.completeMany([task.id]);

      expect(result.succeeded).toEqual([]);
      expect(result.failed).toEqual([
        {
          taskId: task.id,
          error: expect.any(Error),
        },
      ]);
    });
  });

  describe('failMany', () => {
    test('returns empty result for empty input', async () => {
      await expect(dataStore.failMany([])).resolves.toEqual({
        succeeded: [],
        failed: [],
      });
    });

    test('fails claimed tasks in bulk', async () => {
      const task = await dataStore.schedule({
        kind: 'test',
        data: { test: 'test' },
        priority: 1,
        when: new Date(Date.now() - 1),
      });

      await dataStore.claimMany({
        kind: 'test',
        batchSize: 1,
        claimStaleTimeoutMs: TEST_CLAIM_STALE_TIMEOUT_MS,
      });

      const result = await dataStore.failMany([task.id]);

      expect(result.failed).toEqual([]);
      expect(result.succeeded).toEqual([
        expect.objectContaining({
          id: task.id,
          status: TaskStatus.FAILED,
        }),
      ]);
    });
  });

  describe('retryMany', () => {
    test('returns empty result for empty input', async () => {
      await expect(dataStore.retryMany([])).resolves.toEqual({
        succeeded: [],
        failed: [],
      });
    });

    test('retries claimed tasks with per-task retryAt values', async () => {
      const task = await dataStore.schedule({
        kind: 'test',
        data: { test: 'test' },
        priority: 1,
        when: new Date(Date.now() - 1),
      });

      await dataStore.claimMany({
        kind: 'test',
        batchSize: 1,
        claimStaleTimeoutMs: TEST_CLAIM_STALE_TIMEOUT_MS,
      });

      const retryAt = new Date(Date.now() + 60_000);
      const result = await dataStore.retryMany([{ taskId: task.id, retryAt }]);

      expect(result.failed).toEqual([]);
      expect(result.succeeded).toEqual([
        expect.objectContaining({
          id: task.id,
          status: TaskStatus.PENDING,
          scheduledAt: retryAt,
          retryCount: 1,
        }),
      ]);
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

  describe('uninitializedDatastoreBehavior', () => {
    describe('config defaults', () => {
      test('defaults to queue behavior when no config is provided', async () => {
        const store = new ChronoMongoDatastore<TaskMapping>();

        // Should not reject -- returns a pending promise (queue behavior)
        await expect(Promise.race([store.getDatabase(), Promise.resolve('pending')])).resolves.toBe('pending');
      });
    });

    describe('throw behavior', () => {
      test('getDatabase() rejects when behavior is throw and datastore is not initialized', async () => {
        const store = new ChronoMongoDatastore<TaskMapping>({
          uninitializedDatastoreBehavior: 'throw',
          collectionName: TEST_DB_COLLECTION_NAME,
        });

        await expect(store.getDatabase()).rejects.toThrow('Datastore is not initialized');
      });
    });

    describe('maxQueueSize', () => {
      test('allows up to maxQueueSize queued getDatabase() calls', async () => {
        const store = new ChronoMongoDatastore<TaskMapping>({
          uninitializedDatastoreBehavior: 'queue',
          maxQueueSize: 2,
          collectionName: TEST_DB_COLLECTION_NAME,
        });

        // Both calls should return pending promises without rejecting
        const promise1 = store.getDatabase();
        const promise2 = store.getDatabase();

        await expect(Promise.race([promise1, Promise.resolve('pending')])).resolves.toBe('pending');
        await expect(Promise.race([promise2, Promise.resolve('pending')])).resolves.toBe('pending');
      });

      test('rejects when maxQueueSize is exceeded', async () => {
        const store = new ChronoMongoDatastore<TaskMapping>({
          uninitializedDatastoreBehavior: 'queue',
          maxQueueSize: 2,
          collectionName: TEST_DB_COLLECTION_NAME,
        });

        store.getDatabase();
        store.getDatabase();

        await expect(store.getDatabase()).rejects.toThrow('Maximum queue size reached for uninitialized datastore');
      });
    });
  });
});
