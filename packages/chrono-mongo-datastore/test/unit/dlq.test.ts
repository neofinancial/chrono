import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { type Collection, MongoClient, ObjectId } from 'mongodb';
import { ChronoMongoDatastore, type TaskDocument } from '../../src/chrono-mongo-datastore';
import { TaskStatus } from '@neofinancial/chrono';

type TaskMapping = {
  'failed-task': { reason: string };
};

const DB_NAME = 'chrono_test';
const TASKS_COLLECTION = 'dlq_tasks';

describe('ChronoMongoDatastore DLQ', () => {
  let mongoClient: MongoClient;
  let datastore: ChronoMongoDatastore<TaskMapping>;
  let collection: Collection<TaskDocument<keyof TaskMapping, TaskMapping[keyof TaskMapping]>>;

  beforeAll(async () => {
    mongoClient = new MongoClient('mongodb://localhost:27017');
    await mongoClient.connect();

    collection = mongoClient.db(DB_NAME).collection(TASKS_COLLECTION);

    datastore = new ChronoMongoDatastore<TaskMapping>({
      collectionName: TASKS_COLLECTION,
      dlqCollectionName: `${TASKS_COLLECTION}-dlq`,
    });

    await datastore.initialize(mongoClient.db(DB_NAME));
  });

  beforeEach(async () => {
    await collection.deleteMany({});
    await mongoClient.db(DB_NAME).collection(`${TASKS_COLLECTION}-dlq`).deleteMany({});
  });

  afterAll(async () => {
    await mongoClient.close();
  });

  test('should add a failed task to the DLQ', async () => {
    const taskId = new ObjectId();
    const task = {
      id: taskId.toHexString(),
      kind: 'failed-task' as const,
      status: TaskStatus.FAILED,
      data: { reason: 'Something went wrong' },
      originalScheduleDate: new Date(),
      scheduledAt: new Date(),
      retryCount: 1,
      priority: 0,
    };

    await datastore.addToDlq(task);

    const dlqTask = await mongoClient
      .db(DB_NAME)
      .collection(`${TASKS_COLLECTION}-dlq`)
      .findOne({ _id: taskId });

    expect(dlqTask).not.toBeNull();
    expect(dlqTask?.status).toBe(TaskStatus.FAILED);
  });

  test('should redrive tasks from DLQ back to main queue', async () => {
    const taskId = new ObjectId();
    const task = {
      id: taskId.toHexString(),
      kind: 'failed-task' as const,
      status: TaskStatus.FAILED,
      data: { reason: 'Temporary issue' },
      originalScheduleDate: new Date(),
      scheduledAt: new Date(),
      retryCount: 1,
      priority: 0,
    };

    await datastore.addToDlq(task);
    await datastore.redriveFromDlq();

    const dlqCount = await mongoClient
      .db(DB_NAME)
      .collection(`${TASKS_COLLECTION}-dlq`)
      .countDocuments();
    expect(dlqCount).toBe(0);

    const mainTask = await collection.findOne({ _id: taskId });
    expect(mainTask).not.toBeNull();
    expect(mainTask?.status).toBe(TaskStatus.PENDING);
  });

  test('should not fail when DLQ is empty during redrive', async () => {
    await datastore.redriveFromDlq();

    const dlqCount = await mongoClient
      .db(DB_NAME)
      .collection(`${TASKS_COLLECTION}-dlq`)
      .countDocuments();
    const mainCount = await collection.countDocuments();

    expect(dlqCount).toBe(0);
    expect(mainCount).toBe(0);
  });

  test('should move task to DLQ after max retries and allow redrive', async () => {
    const taskId = new ObjectId();
    const task = {
      id: taskId.toHexString(),
      kind: 'failed-task' as const,
      status: TaskStatus.CLAIMED,
      data: { reason: 'Max retry reached' },
      originalScheduleDate: new Date(),
      scheduledAt: new Date(),
      retryCount: 5,
      priority: 0,
    };

    // Insert directly into main collection with _id
    await collection.insertOne({ ...task, _id: taskId });

    // Move to DLQ
    await datastore.addToDlq(task);

    let dlqTask = await mongoClient
      .db(DB_NAME)
      .collection(`${TASKS_COLLECTION}-dlq`)
      .findOne({ _id: taskId });
    expect(dlqTask).not.toBeNull();

    // Redrive back to main queue
    await datastore.redriveFromDlq();

    dlqTask = await mongoClient
      .db(DB_NAME)
      .collection(`${TASKS_COLLECTION}-dlq`)
      .findOne({ _id: taskId });
    expect(dlqTask).toBeNull();

    const mainTask = await collection.findOne({ _id: taskId });
    expect(mainTask?.status).toBe(TaskStatus.PENDING);
  });
});
