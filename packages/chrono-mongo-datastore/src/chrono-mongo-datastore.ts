import {
  type Datastore,
  type ScheduleInput,
  type Task,
  type TaskMappingBase,
  TaskStatus,
} from '@neofinancial/chrono-core';
import type { ClaimTaskInput } from '@neofinancial/chrono-core/build/datastore';
import { type ClientSession, type Db, ObjectId, type OptionalId, type WithId } from 'mongodb';
import { IndexNames, ensureIndexes } from './mongo-indexes';

const DEFAULT_COLLECTION_NAME = 'chrono-tasks';
const DEFAULT_COMPLETED_DOCUMENT_TTL = 60 * 60 * 24; // 1 day
const DEFAULT_CLAIM_STALE_TIMEOUT = 10_000; // 10 seconds

export type ChronoMongoDatastoreConfig = {
  completedDocumentTTL?: number;
  collectionName?: string;
  claimStaleTimeout?: number;
};

export type MongoDatastoreOptions = {
  session?: ClientSession;
};

export type TaskDocument<TaskKind, TaskData> = WithId<Omit<Task<TaskKind, TaskData>, 'id'>>;

export class ChronoMongoDatastore<TaskMapping extends TaskMappingBase>
  implements Datastore<TaskMapping, MongoDatastoreOptions>
{
  private config: Required<ChronoMongoDatastoreConfig>;
  private database: Db;

  private constructor(database: Db, config?: ChronoMongoDatastoreConfig) {
    this.database = database;
    this.config = {
      completedDocumentTTL: config?.completedDocumentTTL || DEFAULT_COMPLETED_DOCUMENT_TTL,
      claimStaleTimeout: config?.claimStaleTimeout || DEFAULT_CLAIM_STALE_TIMEOUT,
      collectionName: config?.collectionName || DEFAULT_COLLECTION_NAME,
    };
  }

  static async create<TaskMapping extends TaskMappingBase>(
    database: Db,
    config?: ChronoMongoDatastoreConfig,
  ): Promise<ChronoMongoDatastore<TaskMapping>> {
    const datastore = new ChronoMongoDatastore<TaskMapping>(database, config);

    await ensureIndexes(datastore.database.collection(datastore.config.collectionName), {
      completedDocumentTTL: datastore.config.completedDocumentTTL,
    });

    return datastore;
  }

  async schedule<TaskKind extends keyof TaskMapping>(
    input: ScheduleInput<TaskKind, TaskMapping[TaskKind], MongoDatastoreOptions>,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]>> {
    const createInput: OptionalId<TaskDocument<TaskKind, TaskMapping[TaskKind]>> = {
      kind: input.kind,
      status: TaskStatus.PENDING,
      data: input.data,
      priority: input.priority,
      idempotencyKey: input.idempotencyKey,
      originalScheduleDate: input.when,
      scheduledAt: input.when,
      retryCount: 0,
    };

    try {
      const results = await this.database.collection(this.config.collectionName).insertOne(createInput, {
        ...(input?.datastoreOptions?.session ? { session: input.datastoreOptions.session } : undefined),
        ignoreUndefined: true,
      });

      if (results.acknowledged) {
        return this.toObject({ _id: results.insertedId, ...createInput });
      }
    } catch (error) {
      if (
        input.idempotencyKey &&
        error instanceof Error &&
        'code' in error &&
        (error.code === 11000 || error.code === 11001)
      ) {
        const existingTask = await this.database
          .collection<TaskDocument<TaskKind, TaskMapping[TaskKind]>>(this.config.collectionName)
          .findOne(
            {
              idempotencyKey: input.idempotencyKey,
            },
            {
              hint: IndexNames.IDEMPOTENCY_KEY_INDEX,
              ...(input.datastoreOptions?.session ? { session: input.datastoreOptions.session } : undefined),
            },
          );

        if (existingTask) {
          return this.toObject(existingTask);
        }

        throw new Error(
          `Failed to find existing task with idempotency key ${input.idempotencyKey} despite unique index error`,
        );
      }
      throw error;
    }

    throw new Error(`Failed to insert ${String(input.kind)} document`);
  }

  async claim<TaskKind extends Extract<keyof TaskMapping, string>>(
    input: ClaimTaskInput<TaskKind>,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]> | undefined> {
    const now = new Date();
    const task = await this.database
      .collection<TaskDocument<TaskKind, TaskMapping[TaskKind]>>(this.config.collectionName)
      .findOneAndUpdate(
        {
          kind: input.kind,
          scheduledAt: { $lte: now },
          $or: [
            { status: TaskStatus.PENDING },
            {
              status: TaskStatus.CLAIMED,
              claimedAt: {
                $lte: new Date(now.getTime() - this.config.claimStaleTimeout),
              },
            },
          ],
        },
        { $set: { status: TaskStatus.CLAIMED, claimedAt: now } },
        {
          sort: { priority: -1, scheduledAt: 1 },
          // hint: IndexNames.CLAIM_DOCUMENT_INDEX as unknown as Document,
          returnDocument: 'after',
        },
      );

    return task ? this.toObject(task) : undefined;
  }

  async unclaim<TaskKind extends keyof TaskMapping>(
    taskId: string,
    nextScheduledAt: Date,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]>> {
    const task = await this.database
      .collection<TaskDocument<TaskKind, TaskMapping[TaskKind]>>(this.config.collectionName)
      .findOneAndUpdate(
        { _id: new ObjectId(taskId) },
        {
          $set: {
            status: TaskStatus.PENDING,
            scheduledAt: nextScheduledAt,
          },
          $inc: {
            retryCount: 1,
          },
        },
        {
          returnDocument: 'after',
        },
      );

    if (!task) {
      throw new Error(`Task with ID ${taskId} not found`);
    }

    return this.toObject(task);
  }

  async complete<TaskKind extends keyof TaskMapping>(taskId: string): Promise<Task<TaskKind, TaskMapping[TaskKind]>> {
    const now = new Date();

    const task = await this.database
      .collection<TaskDocument<TaskKind, TaskMapping[TaskKind]>>(this.config.collectionName)
      .findOneAndUpdate(
        { _id: new ObjectId(taskId) },
        {
          $set: {
            status: TaskStatus.COMPLETED,
            completedAt: now,
            lastExecutedAt: now,
          },
        },
        {
          returnDocument: 'after',
        },
      );

    if (!task) {
      throw new Error(`Task with ID ${taskId} not found`);
    }

    return this.toObject(task);
  }

  async fail<TaskKind extends keyof TaskMapping>(taskId: string): Promise<Task<TaskKind, TaskMapping[TaskKind]>> {
    const now = new Date();

    const task = await this.database
      .collection<TaskDocument<TaskKind, TaskMapping[TaskKind]>>(this.config.collectionName)
      .findOneAndUpdate(
        { _id: new ObjectId(taskId) },
        {
          $set: {
            status: TaskStatus.FAILED,
            lastExecutedAt: now,
          },
        },
        {
          returnDocument: 'after',
        },
      );
    if (!task) {
      throw new Error(`Task with ID ${taskId} not found`);
    }
    return this.toObject(task);
  }

  private toObject<TaskKind extends keyof TaskMapping>(
    document: TaskDocument<TaskKind, TaskMapping[TaskKind]>,
  ): Task<TaskKind, TaskMapping[TaskKind]> {
    return {
      id: document._id.toHexString(),
      data: document.data,
      kind: document.kind,
      status: document.status,
      priority: document.priority ?? undefined,
      idempotencyKey: document.idempotencyKey ?? undefined,
      originalScheduleDate: document.originalScheduleDate,
      scheduledAt: document.scheduledAt,
      claimedAt: document.claimedAt ?? undefined,
      completedAt: document.completedAt ?? undefined,
      retryCount: document.retryCount,
    };
  }
}
