import { MongoClient, ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { ChronoMongoDatastore } from '../../src/chrono-mongo-datastore';
import { DB_NAME } from '../database-setup';

type TaskMapping = {
  test: {
    test: string;
  };
};

const TEST_DB_COLLECTION_NAME = 'test_tasks';

describe('ChronoMongoDatastore', () => {
  let mongoClient: MongoClient;

  beforeAll(async () => {
    mongoClient = new MongoClient('mongodb://localhost:27017');
    await mongoClient.connect();
  });

  afterAll(async () => {
    await mongoClient.close();
  });

  describe('schedule', () => {
    let chrono: ChronoMongoDatastore<TaskMapping>;

    beforeAll(() => {
      chrono = new ChronoMongoDatastore(mongoClient.db(DB_NAME), {
        collectionName: TEST_DB_COLLECTION_NAME,
      });
    });

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
});
