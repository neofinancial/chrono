import {
  type Datastore,
  type ScheduleInput,
  type Task,
  type TaskMappingBase,
  TaskStatus,
} from '@neofinancial/chrono-core';
import type { ClaimTaskInput } from '@neofinancial/chrono-core/build/datastore';
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
const DEFAULT_CLAIM_STALE_TIMEOUT = 10_000; // 10 seconds

export type ChronoMongoDatastoreConfig = {
  completedDocumentTTL?: number;
  collectionName: string;
  claimStaleTimeout: number;
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
      completedDocumentTTL: config?.completedDocumentTTL,
      claimStaleTimeout: config?.claimStaleTimeout || DEFAULT_CLAIM_STALE_TIMEOUT,
      collectionName: config?.collectionName || DEFAULT_COLLECTION_NAME,
    };
  }

  static async create<TaskMapping extends TaskMappingBase>(
    database: Db,
    config?: Partial<ChronoMongoDatastoreConfig>,
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

  async claim<TaskKind extends Extract<keyof TaskMapping, string>>(
    input: ClaimTaskInput<TaskKind>,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]> | undefined> {
    const now = new Date();
    const claimedAtStaleTimeout = new Date(now.getTime() - this.config.claimStaleTimeout);

    const possibleTasks = await this.collection<TaskKind>()
      .aggregate([
        // 1. Initial Match: Find potential candidates
        {
          $match: {
            kind: input.kind,
            scheduledAt: { $lte: now },
            $or: [
              { status: TaskStatus.PENDING },
              {
                status: TaskStatus.CLAIMED,
                claimedAt: {
                  $lte: claimedAtStaleTimeout,
                },
              },
            ],
          },
        },
        // 2. Lookup Blocking Tasks: Check for earlier, active tasks in the same group
        {
          $lookup: {
            from: this.config.collectionName,
            let: {
              current_groupId: '$groupId',
              current_originalScheduledAt: '$originalScheduleDate',
              current_id: '$_id',
            },
            pipeline: [
              {
                $match: {
                  // Match documents that could potentially block the current one
                  groupId: { $ne: null }, // Only apply FIFO to tasks with a groupId
                  $expr: {
                    $and: [
                      { $ne: ['$_id', '$$current_id'] }, // Not the same task
                      { $eq: ['$groupId', '$$current_groupId'] }, // Same group
                      { $lt: ['$originalScheduleDate', '$$current_originalScheduledAt'] }, // originalScheduled *before* the current task
                      { $in: ['$status', [TaskStatus.PENDING, TaskStatus.CLAIMED, TaskStatus.FAILED]] }, // Is in a blocking state (PENDING or CLAIMED or FAILED)
                    ],
                  },
                },
              },
              // Optimization: We only need to know if *any* blocker exists
              { $project: { _id: 1 } },
              { $limit: 1 },
            ],
            as: 'blockingTasks',
          },
        },
        // 3. Filter Based on Lookup: Only keep tasks with NO blocking tasks
        {
          $match: {
            // Keep documents where the blockingTasks array is empty
            blockingTasks: { $size: 0 },
          },
        },
        // 4. Sort: Prioritize the earliest scheduled task, then by priority
        {
          $sort: {
            priority: -1, // Then by priority (high to low)
            scheduledAt: 1, // Enforce overall earliest schedule first
            _id: 1, // Deterministic tie-breaker
          },
        },
        // 5. Limit: Get only the single best candidate
        {
          $limit: 1,
        },
      ])
      .toArray();

    const possibleTask = possibleTasks.shift();

    if (!possibleTask) {
      return undefined;
    }

    const task = await this.collection<TaskKind>().findOneAndUpdate(
      {
        _id: possibleTask._id,
        $or: [
          { status: TaskStatus.PENDING },
          {
            status: TaskStatus.CLAIMED,
            claimedAt: {
              $lte: claimedAtStaleTimeout,
            },
          },
        ],
      },
      { $set: { status: TaskStatus.CLAIMED, claimedAt: now } },
      {
        returnDocument: 'after',
      },
    );

    return task ? this.toObject(task) : undefined;
  }

  async unclaim<TaskKind extends keyof TaskMapping>(
    taskId: string,
    nextScheduledAt: Date,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]>> {
    const taskDocument = await this.updateOrThrow<TaskKind>(taskId, {
      $set: {
        status: TaskStatus.PENDING,
        scheduledAt: nextScheduledAt,
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
