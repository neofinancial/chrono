import { randomUUID } from 'node:crypto';

import {
  type BulkDatastore,
  type BulkWriteResult,
  type ClaimManyInput,
  type ClaimTaskInput,
  type Datastore,
  type DeleteInput,
  type DeleteOptions,
  type RetryManyItem,
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
import { ensureIndexes, IndexNames } from './mongo-indexes';

const DEFAULT_COLLECTION_NAME = 'chrono-tasks';

/**
 * Configuration for the datastore behavior when it is called before the datastore is initialized.
 *
 * @default { uninitializedDatastoreBehavior: 'queue', maxQueueSize: undefined }
 */
type UninitializedDatastoreBehaviorConfig =
  /**
   * Queue operations when the datastore is not initialized. If maxQueueSize is reached, an error will be thrown.
   * If maxQueueSize is not defined, operations will be queued indefinitely.
   * @throws {Error} If the maxQueueSize is reached.
   */
  | { uninitializedDatastoreBehavior: 'queue'; maxQueueSize?: number }
  /**
   * Throw an error when the datastore is accessed before it is initialized.
   */
  | { uninitializedDatastoreBehavior: 'throw' };

/**
 * Configuration for the ChronoMongoDatastore.
 *
 * @type {ChronoMongoDatastoreConfig}
 */
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
} & UninitializedDatastoreBehaviorConfig;

export type MongoDatastoreOptions = {
  session?: ClientSession;
};

export type TaskDocument<TaskKind, TaskData> = WithId<Omit<Task<TaskKind, TaskData>, 'id'>> & {
  claimBatchId?: string;
};

export class ChronoMongoDatastore<TaskMapping extends TaskMappingBase>
  implements Datastore<TaskMapping, MongoDatastoreOptions>, BulkDatastore<TaskMapping, MongoDatastoreOptions>
{
  private config: ChronoMongoDatastoreConfig;
  private database: Db | undefined;
  private databaseResolvers: Array<(database: Db) => void> = [];

  constructor(config?: Partial<ChronoMongoDatastoreConfig>) {
    const { completedDocumentTTLSeconds, collectionName, ...rest } = config || {};

    this.config = {
      completedDocumentTTLSeconds: config?.completedDocumentTTLSeconds,
      collectionName: config?.collectionName || DEFAULT_COLLECTION_NAME,
      uninitializedDatastoreBehavior: rest.uninitializedDatastoreBehavior || 'queue',
      ...(rest.uninitializedDatastoreBehavior === 'queue' ? { maxQueueSize: rest.maxQueueSize } : undefined),
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
   * Asynchronously gets the database connection for the datastore. If the database is not set, it will return a promise that resolves when the database is set.
   *
   * @returns The database connection.
   */
  public async getDatabase(): Promise<Db> {
    if (this.database) {
      return this.database;
    }

    if (this.config.uninitializedDatastoreBehavior === 'throw') {
      throw new Error('Datastore is not initialized');
    }

    if (
      this.config.uninitializedDatastoreBehavior === 'queue' &&
      this.config.maxQueueSize !== undefined &&
      this.databaseResolvers.length >= this.config.maxQueueSize
    ) {
      throw new Error('Maximum queue size reached for uninitialized datastore');
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
      this.buildClaimableFilter({
        kind: input.kind,
        now,
        claimStaleTimeoutMs: input.claimStaleTimeoutMs,
      }),
      { $set: { status: TaskStatus.CLAIMED, claimedAt: now } },
      {
        sort: { priority: -1, scheduledAt: 1 },
        // hint: IndexNames.CLAIM_DOCUMENT_INDEX as unknown as Document,
        returnDocument: 'after',
      },
    );

    return task ? this.toObject(task) : undefined;
  }

  async claimMany<TaskKind extends Extract<keyof TaskMapping, string>>(
    input: ClaimManyInput<TaskKind>,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]>[]> {
    const now = new Date();
    const claimBatchId = randomUUID();
    const collection = await this.collection<TaskKind>();
    const claimableFilter = this.buildClaimableFilter({
      kind: input.kind,
      now,
      claimStaleTimeoutMs: input.claimStaleTimeoutMs,
    });

    const candidates = await collection
      .find(claimableFilter)
      .sort({ priority: -1, scheduledAt: 1 })
      .limit(input.batchSize)
      .toArray();

    if (candidates.length === 0) {
      return [];
    }

    const candidateIds = candidates.map((document) => document._id);

    await collection.updateMany(
      {
        ...claimableFilter,
        _id: { $in: candidateIds },
      },
      { $set: { status: TaskStatus.CLAIMED, claimedAt: now, claimBatchId } },
    );

    const claimedDocuments = await collection
      .find({
        _id: { $in: candidateIds },
        claimBatchId,
      })
      .sort({ priority: -1, scheduledAt: 1 })
      .toArray();

    return claimedDocuments.map((document) => this.toObject(document));
  }

  async completeMany<TaskKind extends keyof TaskMapping>(
    taskIds: string[],
  ): Promise<BulkWriteResult<TaskKind, TaskMapping[TaskKind]>> {
    if (taskIds.length === 0) {
      return { succeeded: [], failed: [] };
    }

    const now = new Date();
    const collection = await this.collection<TaskKind>();
    const { objectIds, invalid } = this.parseTaskIds<TaskKind>(taskIds);

    if (objectIds.length === 0) {
      return { succeeded: [], failed: invalid };
    }

    const updateResult = await collection.updateMany(
      {
        _id: { $in: objectIds },
        status: TaskStatus.CLAIMED,
      },
      {
        $set: {
          status: TaskStatus.COMPLETED,
          completedAt: now,
          lastExecutedAt: now,
        },
      },
    );

    return this.buildBulkWriteResultFromUpdate({
      collection,
      objectIds,
      invalid,
      modifiedCount: updateResult.modifiedCount,
      resultStatus: TaskStatus.COMPLETED,
    });
  }

  async retryMany<TaskKind extends keyof TaskMapping>(
    items: RetryManyItem[],
  ): Promise<BulkWriteResult<TaskKind, TaskMapping[TaskKind]>> {
    if (items.length === 0) {
      return { succeeded: [], failed: [] };
    }

    const collection = await this.collection<TaskKind>();
    const operations: { taskId: string; objectId: ObjectId; retryAt: Date }[] = [];
    const failed: { taskId: string; error: unknown }[] = [];

    for (const item of items) {
      if (!ObjectId.isValid(item.taskId)) {
        failed.push({ taskId: item.taskId, error: new Error(`Invalid task ID ${item.taskId}`) });
        continue;
      }

      operations.push({
        taskId: item.taskId,
        objectId: new ObjectId(item.taskId),
        retryAt: item.retryAt,
      });
    }

    if (operations.length === 0) {
      return { succeeded: [], failed };
    }

    const bulkWriteResult = await collection.bulkWrite(
      operations.map((operation) => ({
        updateOne: {
          filter: { _id: operation.objectId, status: TaskStatus.CLAIMED },
          update: {
            $set: {
              status: TaskStatus.PENDING,
              scheduledAt: operation.retryAt,
            },
            $inc: {
              retryCount: 1,
            },
          },
        },
      })),
      { ordered: false },
    );

    for (const writeError of bulkWriteResult.getWriteErrors()) {
      const operation = operations[writeError.index];
      if (operation) {
        failed.push({ taskId: operation.taskId, error: writeError });
      }
    }

    if (bulkWriteResult.modifiedCount === operations.length && bulkWriteResult.getWriteErrorCount() === 0) {
      const succeededDocuments = await collection
        .find({
          _id: { $in: operations.map((operation) => operation.objectId) },
        })
        .toArray();

      return {
        succeeded: succeededDocuments.map((document) => this.toObject(document)),
        failed,
      };
    }

    const succeededDocuments = await collection
      .find({
        _id: { $in: operations.map((operation) => operation.objectId) },
        status: TaskStatus.PENDING,
      })
      .toArray();

    const succeededIds = new Set(succeededDocuments.map((document) => document._id.toHexString()));
    const failedTaskIds = new Set(failed.map((failure) => failure.taskId));

    for (const operation of operations) {
      if (failedTaskIds.has(operation.taskId) || succeededIds.has(operation.taskId)) {
        continue;
      }

      failed.push({
        taskId: operation.taskId,
        error: new Error(`Task with ID ${operation.taskId} not found or not in CLAIMED status`),
      });
    }

    return {
      succeeded: succeededDocuments.map((document) => this.toObject(document)),
      failed,
    };
  }

  async failMany<TaskKind extends keyof TaskMapping>(
    taskIds: string[],
  ): Promise<BulkWriteResult<TaskKind, TaskMapping[TaskKind]>> {
    if (taskIds.length === 0) {
      return { succeeded: [], failed: [] };
    }

    const now = new Date();
    const collection = await this.collection<TaskKind>();
    const { objectIds, invalid } = this.parseTaskIds<TaskKind>(taskIds);

    if (objectIds.length === 0) {
      return { succeeded: [], failed: invalid };
    }

    const updateResult = await collection.updateMany(
      {
        _id: { $in: objectIds },
        status: TaskStatus.CLAIMED,
      },
      {
        $set: {
          status: TaskStatus.FAILED,
          lastExecutedAt: now,
        },
      },
    );

    return this.buildBulkWriteResultFromUpdate({
      collection,
      objectIds,
      invalid,
      modifiedCount: updateResult.modifiedCount,
      resultStatus: TaskStatus.FAILED,
    });
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

  private buildClaimableFilter<TaskKind extends Extract<keyof TaskMapping, string>>(input: {
    kind: TaskKind;
    now: Date;
    claimStaleTimeoutMs: number;
  }) {
    return {
      kind: input.kind,
      scheduledAt: { $lte: input.now },
      $or: [
        { status: TaskStatus.PENDING },
        {
          status: TaskStatus.CLAIMED,
          claimedAt: {
            $lte: new Date(input.now.getTime() - input.claimStaleTimeoutMs),
          },
        },
      ],
    };
  }

  private async buildBulkWriteResultFromUpdate<TaskKind extends keyof TaskMapping>(input: {
    collection: Collection<TaskDocument<TaskKind, TaskMapping[TaskKind]>>;
    objectIds: ObjectId[];
    invalid: BulkWriteResult<TaskKind, TaskMapping[TaskKind]>['failed'];
    modifiedCount: number;
    resultStatus: TaskStatus;
  }): Promise<BulkWriteResult<TaskKind, TaskMapping[TaskKind]>> {
    if (input.modifiedCount === input.objectIds.length) {
      const succeededDocuments = await input.collection
        .find({
          _id: { $in: input.objectIds },
        })
        .toArray();

      return {
        succeeded: succeededDocuments.map((document) => this.toObject(document)),
        failed: input.invalid,
      };
    }

    const succeededDocuments = await input.collection
      .find({
        _id: { $in: input.objectIds },
        status: input.resultStatus,
      })
      .toArray();

    const succeededIds = new Set(succeededDocuments.map((document) => document._id.toHexString()));
    const notClaimedFailed = input.objectIds
      .filter((objectId) => !succeededIds.has(objectId.toHexString()))
      .map((objectId) => {
        const taskId = objectId.toHexString();
        return {
          taskId,
          error: new Error(`Task with ID ${taskId} not found or not in CLAIMED status`),
        };
      });

    return {
      succeeded: succeededDocuments.map((document) => this.toObject(document)),
      failed: [...input.invalid, ...notClaimedFailed],
    };
  }

  private parseTaskIds<TaskKind extends keyof TaskMapping>(
    taskIds: string[],
  ): {
    objectIds: ObjectId[];
    invalid: BulkWriteResult<TaskKind, TaskMapping[TaskKind]>['failed'];
  } {
    const objectIds: ObjectId[] = [];
    const invalid: BulkWriteResult<TaskKind, TaskMapping[TaskKind]>['failed'] = [];

    for (const taskId of taskIds) {
      if (ObjectId.isValid(taskId)) {
        objectIds.push(new ObjectId(taskId));
      } else {
        invalid.push({ taskId, error: new Error(`Invalid task ID ${taskId}`) });
      }
    }

    return { objectIds, invalid };
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
