import { MongoClient } from 'mongodb';
/* eslint-disable no-console */
import { MongoMemoryServer } from 'mongodb-memory-server';

const formatMemoryUsage = (data: number) => `${Math.round((data / 1024 / 1024) * 100) / 100} MB`;

let mongoServer: MongoMemoryServer | undefined;

export const DB_NAME = 'test';

/**
 * @remarks
 * https://vitest.dev/config/#globalsetup
 */
export async function setup(): Promise<void> {
  const { heapTotal: heapTotalBefore, heapUsed: heapUsedBefore } = process.memoryUsage();

  mongoServer = await MongoMemoryServer.create({
    instance: {
      dbName: DB_NAME,
      storageEngine: 'wiredTiger',
      port: 27017,
    },
  });

  const uri = mongoServer.getUri();
  const mongoUri = uri.slice(0, uri.lastIndexOf('/'));

  console.table({
    mongoUri,
    heapTotal: formatMemoryUsage(heapTotalBefore),
    heapUsed: formatMemoryUsage(heapUsedBefore),
  });

  const client = new MongoClient(mongoUri);

  await client.connect();
  console.log('Connected successfully to server');
  const db = client.db(DB_NAME);

  await db.dropDatabase();

  await client.close();
}

/**
 * @remarks
 * https://vitest.dev/config/#globalsetup
 */
export async function teardown(): Promise<void> {
  const { heapTotal: heapTotalAfter, heapUsed: heapUsedAfter } = process.memoryUsage();

  await mongoServer?.stop({ force: true, doCleanup: true });

  console.log({
    heapTotal: formatMemoryUsage(heapTotalAfter),
    heapUsed: formatMemoryUsage(heapUsedAfter),
  });
}
