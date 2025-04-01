import {
  type Datastore,
  type ScheduleInput,
  type Task,
  type TaskMappingBase,
  TaskStatus,
} from '@neofinancial/chrono-core';
import type { ClaimTaskInput } from '@neofinancial/chrono-core/build/datastore';
import type { ClientSession, Db, OptionalId, WithId } from 'mongodb';

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

type TaskDocument<TaskKind, TaskData> = WithId<Omit<Task<TaskKind, TaskData>, 'id'>>;

export class ChronoMongoDatastore<TaskMapping extends TaskMappingBase>
  implements Datastore<TaskMapping, MongoDatastoreOptions>
{
  private config: Required<ChronoMongoDatastoreConfig>;
  private database: Db;

  constructor(database: Db, config?: ChronoMongoDatastoreConfig) {
    this.database = database;
    this.config = {
      completedDocumentTTL: config?.completedDocumentTTL || DEFAULT_COMPLETED_DOCUMENT_TTL,
      claimStaleTimeout: config?.claimStaleTimeout || DEFAULT_CLAIM_STALE_TIMEOUT,
      collectionName: config?.collectionName || DEFAULT_COLLECTION_NAME,
    };
  }

  async schedule<TaskKind extends keyof TaskMapping>(
    input: ScheduleInput<TaskKind, TaskMapping[TaskKind], MongoDatastoreOptions>,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]>> {
    const now = new Date();

    const createInput: OptionalId<TaskDocument<TaskKind, TaskMapping[TaskKind]>> = {
      kind: input.kind,
      status: TaskStatus.PENDING,
      data: input.data,
      priority: input.priority,
      idempotencyKey: input.idempotencyKey,
      originalScheduleDate: input.when,
      scheduledAt: now,
    };

    const results = await this.database.collection(this.config.collectionName).insertOne(createInput, {
      ...(input?.datastoreOptions?.session ? { session: input.datastoreOptions.session } : undefined),
    });

    if (results.acknowledged) {
      return this.toObject({ _id: results.insertedId, ...createInput });
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
          $or: [
            { status: TaskStatus.PENDING, scheduledAt: { $lt: now } },
            {
              status: TaskStatus.CLAIMED,
              claimedAt: {
                $lt: new Date(now.getTime() - this.config.claimStaleTimeout),
              },
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

  async complete<TaskKind extends keyof TaskMapping>(_taskId: string): Promise<Task<TaskKind, TaskMapping[TaskKind]>> {
    throw new Error('Method not implemented.');
  }

  async fail<TaskKind extends keyof TaskMapping>(_taskId: string): Promise<Task<TaskKind, TaskMapping[TaskKind]>> {
    throw new Error('Method not implemented.');
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
    };
  }
}
