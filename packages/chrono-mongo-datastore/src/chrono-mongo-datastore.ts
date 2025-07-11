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
  ObjectId,
  type OptionalId,
  type UpdateFilter,
  type WithId,
} from 'mongodb';
import { IndexNames, ensureIndexes } from './mongo-indexes';

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
  implements Datastore<TaskMapping, MongoDatastoreOptions>
{
  private config: ChronoMongoDatastoreConfig;
  private database: Db;

  private constructor(database: Db, config?: Partial<ChronoMongoDatastoreConfig>) {
    this.database = database;
    this.config = {
      completedDocumentTTLSeconds: config?.completedDocumentTTLSeconds,
      collectionName: config?.collectionName || DEFAULT_COLLECTION_NAME,
    };
  }

  static async create<TaskMapping extends TaskMappingBase>(
    database: Db,
    config?: Partial<ChronoMongoDatastoreConfig>,
  ): Promise<ChronoMongoDatastore<TaskMapping>> {
    const datastore = new ChronoMongoDatastore<TaskMapping>(database, config);

    await ensureIndexes(datastore.database.collection(datastore.config.collectionName), {
      expireAfterSeconds: datastore.config.completedDocumentTTLSeconds,
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
        const existingTask = await this.collection<TaskKind>().findOne(
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
    const task = await this.collection<TaskKind>().findOneAndDelete({
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
    const task = await this.collection<TaskKind>().findOneAndUpdate(
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
    const document = await this.collection<TaskKind>().findOneAndUpdate({ _id: new ObjectId(taskId) }, update, {
      returnDocument: 'after',
    });
    if (!document) {
      throw new Error(`Task with ID ${taskId} not found`);
    }
    return document;
  }

  private collection<TaskKind extends keyof TaskMapping>(): Collection<TaskDocument<TaskKind, TaskMapping[TaskKind]>> {
    return this.database.collection<TaskDocument<TaskKind, TaskMapping[TaskKind]>>(this.config.collectionName);
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
