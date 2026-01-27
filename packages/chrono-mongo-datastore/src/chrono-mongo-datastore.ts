import {
  type ClaimTaskInput,
  type CollectStatisticsInput,
  type Datastore,
  type DeleteInput,
  type DeleteOptions,
  type ScheduleInput,
  type Statistics,
  type StatisticsCollectorDatastore,
  type Task,
  type TaskMappingBase,
  TaskStatus,
} from '@neofinancial/chrono';
import {
  type ClientSession,
  type Collection,
  type Db,
  ObjectId,
  type OptionalId,
  type UpdateFilter,
  type WithId,
} from 'mongodb';
import { ensureIndexes, IndexNames } from './mongo-indexes';

const DEFAULT_COLLECTION_NAME = 'chrono-tasks';

export type ChronoMongoDatastoreConfig = {
  /**
   * The TTL (in seconds) for completed documents.
   *
   * @default 60 * 60 * 24 * 30 // 30 days
   * @type {number}
   */
  completedDocumentTTLSeconds?: number;

  /**
   * The name of the collection to use for the datastore.
   *
   * @type {string}
   */
  collectionName: string;
};

export type MongoDatastoreOptions = {
  session?: ClientSession;
};

export type TaskDocument<TaskKind, TaskData> = WithId<Omit<Task<TaskKind, TaskData>, 'id'>>;

export class ChronoMongoDatastore<TaskMapping extends TaskMappingBase>
  implements Datastore<TaskMapping, MongoDatastoreOptions>, StatisticsCollectorDatastore<TaskMapping>
{
  private config: ChronoMongoDatastoreConfig;
  private database: Db | undefined;
  private databaseResolvers: Array<(database: Db) => void> = [];

  constructor(config?: Partial<ChronoMongoDatastoreConfig>) {
    this.config = {
      completedDocumentTTLSeconds: config?.completedDocumentTTLSeconds,
      collectionName: config?.collectionName || DEFAULT_COLLECTION_NAME,
    };
  }

  /**
   * Sets the database connection for the datastore. Ensures that the indexes are created and resolves any pending promises waiting for the database.
   *
   * @param database - The database to set.
   */
  async initialize(database: Db): Promise<void> {
    if (this.database) {
      throw new Error('Database connection already set');
    }

    await ensureIndexes(database.collection(this.config.collectionName), {
      expireAfterSeconds: this.config.completedDocumentTTLSeconds,
    });

    this.database = database;

    const resolvers = this.databaseResolvers.splice(0);
    for (const resolve of resolvers) {
      resolve(database);
    }
  }

  /**
   * Asyncronously gets the database connection for the datastore. If the database is not set, it will return a promise that resolves when the database is set.
   *
   * @returns The database connection.
   */
  public async getDatabase(): Promise<Db> {
    if (this.database) {
      return this.database;
    }

    return new Promise<Db>((resolve) => {
      this.databaseResolvers.push(resolve);
    });
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
      const database = await this.getDatabase();
      const results = await database.collection(this.config.collectionName).insertOne(createInput, {
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
        const collection = await this.collection<TaskKind>();
        const existingTask = await collection.findOne(
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

  async delete<TaskKind extends Extract<keyof TaskMapping, string>>(
    key: DeleteInput<TaskKind>,
    options?: DeleteOptions,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]> | undefined> {
    const filter =
      typeof key === 'string' ? { _id: new ObjectId(key) } : { kind: key.kind, idempotencyKey: key.idempotencyKey };
    const collection = await this.collection<TaskKind>();
    const task = await collection.findOneAndDelete({
      ...filter,
      ...(options?.force ? {} : { status: TaskStatus.PENDING }),
    });

    if (!task) {
      if (options?.force) {
        return;
      }

      const description =
        typeof key === 'string'
          ? `with id ${key}`
          : `with kind ${String(key.kind)} and idempotencyKey ${key.idempotencyKey}`;

      throw new Error(`Task ${description} can not be deleted as it may not exist or it's not in PENDING status.`);
    }

    return this.toObject(task);
  }

  async claim<TaskKind extends Extract<keyof TaskMapping, string>>(
    input: ClaimTaskInput<TaskKind>,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]> | undefined> {
    const now = new Date();
    const collection = await this.collection<TaskKind>();
    const task = await collection.findOneAndUpdate(
      {
        kind: input.kind,
        scheduledAt: { $lte: now },
        $or: [
          { status: TaskStatus.PENDING },
          {
            status: TaskStatus.CLAIMED,
            claimedAt: {
              $lte: new Date(now.getTime() - input.claimStaleTimeoutMs),
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

  public async collectStatistics(input: CollectStatisticsInput<TaskMapping>): Promise<Statistics<TaskMapping>> {
    const collection = await this.collection();

    const stats = await collection.aggregate<{ _id: { kind: keyof TaskMapping; status: TaskStatus }; count: number }>(
      [
        {
          $match: {
            kind: { $in: input.taskKinds },
            status: { $in: [TaskStatus.PENDING, TaskStatus.FAILED, TaskStatus.CLAIMED] },
            scheduledAt: { $lt: new Date() },
          },
        },
        {
          $group: {
            _id: { kind: '$kind', status: '$status' },
            count: { $sum: 1 },
          },
        },
      ],
      { hint: IndexNames.CLAIM_DOCUMENT_INDEX },
    );

    const result: Statistics<TaskMapping> = input.taskKinds.reduce(
      (acc, kind) => {
        acc[kind] = { claimedCount: 0, pendingCount: 0, failedCount: 0 };
        return acc;
      },
      {} as Statistics<TaskMapping>,
    );

    for await (const stat of stats) {
      const kind = stat._id.kind;
      if (stat._id.status === TaskStatus.PENDING) {
        result[kind].pendingCount = stat.count;
      } else if (stat._id.status === TaskStatus.FAILED) {
        result[kind].failedCount = stat.count;
      } else if (stat._id.status === TaskStatus.CLAIMED) {
        result[kind].claimedCount = stat.count;
      }
    }

    return result;
  }

  async retry<TaskKind extends keyof TaskMapping>(
    taskId: string,
    retryAt: Date,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]>> {
    const taskDocument = await this.updateOrThrow<TaskKind>(taskId, {
      $set: {
        status: TaskStatus.PENDING,
        scheduledAt: retryAt,
      },
      $inc: {
        retryCount: 1,
      },
    });

    return this.toObject(taskDocument);
  }

  async complete<TaskKind extends keyof TaskMapping>(taskId: string): Promise<Task<TaskKind, TaskMapping[TaskKind]>> {
    const now = new Date();

    const task = await this.updateOrThrow<TaskKind>(taskId, {
      $set: {
        status: TaskStatus.COMPLETED,
        completedAt: now,
        lastExecutedAt: now,
      },
    });

    return this.toObject(task);
  }

  async fail<TaskKind extends keyof TaskMapping>(taskId: string): Promise<Task<TaskKind, TaskMapping[TaskKind]>> {
    const now = new Date();

    const task = await this.updateOrThrow<TaskKind>(taskId, {
      $set: {
        status: TaskStatus.FAILED,
        lastExecutedAt: now,
      },
    });

    return this.toObject(task);
  }

  private async updateOrThrow<TaskKind extends keyof TaskMapping>(
    taskId: string,
    update: UpdateFilter<TaskDocument<TaskKind, TaskMapping[TaskKind]>>,
  ): Promise<TaskDocument<TaskKind, TaskMapping[TaskKind]>> {
    const collection = await this.collection<TaskKind>();
    const document = await collection.findOneAndUpdate({ _id: new ObjectId(taskId) }, update, {
      returnDocument: 'after',
    });

    if (!document) {
      throw new Error(`Task with ID ${taskId} not found`);
    }
    return document;
  }

  private async collection<TaskKind extends keyof TaskMapping>(): Promise<
    Collection<TaskDocument<TaskKind, TaskMapping[TaskKind]>>
  > {
    const database = await this.getDatabase();
    return database.collection<TaskDocument<TaskKind, TaskMapping[TaskKind]>>(this.config.collectionName);
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
