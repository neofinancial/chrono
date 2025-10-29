import {
  type ClaimTaskInput,
  type Datastore,
  type DeleteInput,
  type DeleteOptions,
  type ScheduleInput,
  type Task,
  type TaskMappingBase,
  TaskStatus,
} from '@neofinancial/chrono';
import {
  type ClientSession,
  type Collection,
  type Db,
  MongoServerError,
  ObjectId,
  type OptionalId,
  type UpdateFilter,
  type WithId,
} from 'mongodb';
import { ensureIndexes, IndexNames } from './mongo-indexes';

const DEFAULT_COLLECTION_NAME = 'chrono-tasks';
const DEFAULT_DLQ_COLLECTION_NAME = 'chrono-tasks-dlq';
const DEFAULT_MAX_DLQ_RETRIES = 3;

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

  /**
   * Optional name of the DLQ collection
   *
   * @type {string}
   */
  dlqCollectionName: string;

  /**
   * Maximum number of times a task can be redriven from DLQ before it's permanently failed
   *
   * @default 3
   * @type {number}
   */
  maxDlqRetries?: number;
};

export type MongoDatastoreOptions = {
  session?: ClientSession;
};

export type TaskDocument<TaskKind, TaskData> = WithId<Omit<Task<TaskKind, TaskData>, 'id'>>;

type DlqTaskDocument<TaskKind, TaskData> = TaskDocument<TaskKind, TaskData> & {
  error?: string;
  failedAt?: Date;
  dlqRetryCount: number;
  lastRedrivenAt?: Date
};

export class ChronoMongoDatastore<TaskMapping extends TaskMappingBase>
  implements Datastore<TaskMapping, MongoDatastoreOptions>
{
  private config: ChronoMongoDatastoreConfig;
  private database: Db | undefined;
  private databaseResolvers: Array<(database: Db) => void> = [];

  constructor(config?: Partial<ChronoMongoDatastoreConfig>) {
    this.config = {
      completedDocumentTTLSeconds: config?.completedDocumentTTLSeconds,
      collectionName: config?.collectionName || DEFAULT_COLLECTION_NAME,
      dlqCollectionName: config?.dlqCollectionName || DEFAULT_DLQ_COLLECTION_NAME,
      maxDlqRetries: config?.maxDlqRetries ?? DEFAULT_MAX_DLQ_RETRIES,
    };
  }

  /**
   * Sets the database connection for the datastore. Ensures that the indexes are created and resolves any pending promises waiting for the database.
   *
   * @param database - The database to set.
   */
  async initialize(database: Db) {
    if (this.database) {
      throw new Error('Database connection already set');
    }

    await ensureIndexes(database.collection(this.config.collectionName), {
      expireAfterSeconds: this.config.completedDocumentTTLSeconds,
    });

    // Ensure DLQ collection exists
    if (!this.config.dlqCollectionName) {
      throw new Error('DLQ collection name is not set');
    }

    await ensureIndexes(database.collection(this.config.dlqCollectionName), {
      expireAfterSeconds: this.config.completedDocumentTTLSeconds,
    });

    this.database = database;

    const resolvers = this.databaseResolvers.splice(0);
    for (const resolve of resolvers) {
      resolve(database);
    }
  }

  /**
   * Asynchronously gets the database connection for the datastore. If the database is not set, it will return a promise that resolves when the database is set.
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
            claimedAt: { $lte: new Date(now.getTime() - input.claimStaleTimeoutMs) },
          },
        ],
      },
      { $set: { status: TaskStatus.CLAIMED, claimedAt: now } },
      {
        sort: { priority: -1, scheduledAt: 1 },
        returnDocument: 'after',
      },
    );

    return task ? this.toObject(task) : undefined;
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

  /**
   * Add a task to the Dead Letter Queue
   *
   * @param task The task to move to DLQ
   * @param error Optional error that caused the task to fail
   */
  async addToDlq<TaskKind extends keyof TaskMapping>(
    task: Task<TaskKind, TaskMapping[TaskKind]>,
    error?: Error,
  ): Promise<void> {
    const database = await this.getDatabase();
    const dlqCollection = database.collection<DlqTaskDocument<TaskKind, TaskMapping[TaskKind]>>(
      this.config.dlqCollectionName,
    );
    const mainCollection = database.collection<TaskDocument<TaskKind, TaskMapping[TaskKind]>>(
      this.config.collectionName,
    );

    // Convert task.id (string) back to ObjectId
    const objectId = new ObjectId(task.id);


    const dlqDoc: DlqTaskDocument<TaskKind, TaskMapping[TaskKind]> = {
      kind: task.kind,
      data: task.data,
      status: TaskStatus.FAILED,
      priority: task.priority,
      idempotencyKey: task.idempotencyKey,
      originalScheduleDate: task.originalScheduleDate,
      scheduledAt: task.scheduledAt,
      claimedAt: task.claimedAt,
      completedAt: task.completedAt,
      retryCount: task.retryCount,
      _id: objectId,
      error: error?.message,
      failedAt: new Date(),
      lastExecutedAt: task.lastExecutedAt ?? new Date(),
      dlqRetryCount: 0,
    };

    // Upsert to handle case where task might already be in DLQ
    await dlqCollection.insertOne(dlqDoc);

    // Remove from main collection by _id
    await mainCollection.deleteOne({ _id: objectId });
  }

  /**
   * Redrive messages from the Dead Letter Queue back into main store
   * Only redrive tasks that haven't exceeded the maximum DLQ retry limit
   */
async redriveFromDlq<TaskKind extends keyof TaskMapping>(): Promise<Task<TaskKind, TaskMapping[TaskKind]>[]> {
  const database = await this.getDatabase();
  const dlqCollection = database.collection<DlqTaskDocument<TaskKind, TaskMapping[TaskKind]>>(
    this.config.dlqCollectionName,
  );
  const mainCollection = database.collection<TaskDocument<TaskKind, TaskMapping[TaskKind]>>(
    this.config.collectionName,
  );

  const maxRetries = this.config.maxDlqRetries ?? DEFAULT_MAX_DLQ_RETRIES;

  const dlqDocs = await dlqCollection
    .find<DlqTaskDocument<TaskKind, TaskMapping[TaskKind]>>({
      $or: [{ dlqRetryCount: { $lt: maxRetries } }, { dlqRetryCount: { $exists: false } }],
    })
    .toArray();

  const redrivenTasks: Task<TaskKind, TaskMapping[TaskKind]>[] = [];
  const now = new Date();

  for (const doc of dlqDocs) {
    const newId = new ObjectId();

    const newMainDoc: TaskDocument<TaskKind, TaskMapping[TaskKind]> = {
      kind: doc.kind,
      data: doc.data,
      status: TaskStatus.PENDING,
      priority: doc.priority,
      idempotencyKey: doc.idempotencyKey,
      originalScheduleDate: doc.originalScheduleDate,
      scheduledAt: now,
      claimedAt: undefined,
      completedAt: undefined,
      retryCount: 0,
      lastExecutedAt: now,
      _id: newId,
    };

    try {
      await mainCollection.insertOne(newMainDoc);

      // Successfully inserted - delete from DLQ
      await dlqCollection.deleteOne({ _id: doc._id });

      redrivenTasks.push({
        id: newId.toHexString(),
        kind: newMainDoc.kind as TaskKind,
        data: newMainDoc.data as TaskMapping[TaskKind],
        status: newMainDoc.status,
        retryCount: newMainDoc.retryCount,
        priority: newMainDoc.priority,
        idempotencyKey: newMainDoc.idempotencyKey,
        originalScheduleDate: newMainDoc.originalScheduleDate,
        scheduledAt: newMainDoc.scheduledAt,
        claimedAt: undefined,
        completedAt: undefined,
      });
    } catch (err: unknown) {
      if (err instanceof MongoServerError && err.code === 11000) {
        await dlqCollection.deleteOne({ _id: doc._id });
        continue;
      }
      console.error(`Failed to redrive task ${doc._id.toHexString()}:`, err);
      continue;
    }
  }

  return redrivenTasks;
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