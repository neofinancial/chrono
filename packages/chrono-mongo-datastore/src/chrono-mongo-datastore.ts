import {
  type Datastore,
  type ScheduleInput,
  type Task,
  type TaskMappingBase,
  TaskStatus,
} from '@neofinancial/chrono-core';
import type { ClaimTaskInput } from '@neofinancial/chrono-core/build/datastore';
import type { ClientSession, Db, OptionalId, WithId } from 'mongodb';

const COLLECTION_NAME = 'chrono-tasks';

export type ChronoMongoDatastoreConfig = {
  completedDocumentTTL?: number; // How to handle index changes??????
};

export type MongoDatastoreOptions = {
  session?: ClientSession;
};

export class ChronoMongoDatastore<TaskMapping extends TaskMappingBase>
  implements Datastore<TaskMapping, MongoDatastoreOptions>
{
  private database: Db;

  constructor(database: Db, config?: ChronoMongoDatastoreConfig) {
    const collection = database.collection<Task<keyof TaskMapping, TaskMapping[keyof TaskMapping]>>(COLLECTION_NAME);

    // TODO
    collection.createIndexes(
      [
        {
          key: { idempotencyKey: 1 },
          name: 'idempotencyKey',
          sparse: true,
          unique: true,
        },
        { key: { status: 1, scheduledAt: 1, priority: 1 } }, // Double check this
        {
          key: { completedAt: 1 },
          partialFilterExpression: {
            status: TaskStatus.COMPLETED,
            completeAt: { $exists: true },
          },
          expireAfterSeconds: config?.completedDocumentTTL || 60 * 60 * 24 * 7, // 7 days
        },
      ],
      {},
    );

    this.database = database;
  }

  async schedule<TaskKind extends keyof TaskMapping>(
    input: ScheduleInput<TaskKind, TaskMapping[TaskKind], MongoDatastoreOptions>,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]>> {
    const now = new Date();

    const createInput: OptionalId<Omit<Task<TaskKind, TaskMapping[TaskKind]>, 'id'>> = {
      kind: input.kind,
      status: TaskStatus.PENDING,
      data: input.data,
      priority: input.priority,
      idempotencyKey: input.idempotencyKey,
      originalScheduleDate: input.when,
      scheduledAt: now,
    };

    const results = await this.database.collection(COLLECTION_NAME).insertOne(createInput, {
      ...(input?.datastoreOptions?.session ? { session: input.datastoreOptions.session } : undefined),
    });

    if (results.acknowledged) {
      return this.toObject({ _id: results.insertedId, ...createInput });
    }

    throw new Error(`Failed to insert ${String(input.kind)} document`);
  }

  async claim<TaskKind extends keyof TaskMapping>(
    _input: ClaimTaskInput<TaskKind>,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]> | undefined> {
    throw new Error('Method not implemented.');
  }
  async complete<TaskKind extends keyof TaskMapping>(_taskId: string): Promise<Task<TaskKind, TaskMapping[TaskKind]>> {
    throw new Error('Method not implemented.');
  }

  async fail<TaskKind extends keyof TaskMapping>(_taskId: string): Promise<Task<TaskKind, TaskMapping[TaskKind]>> {
    throw new Error('Method not implemented.');
  }

  private toObject<TaskKind extends keyof TaskMapping>(
    document: WithId<Omit<Task<TaskKind, TaskMapping[TaskKind]>, 'id'>>,
  ): Task<TaskKind, TaskMapping[TaskKind]> {
    return {
      id: document._id.toHexString(),
      data: document.data,
      kind: document.kind,
      status: document.status,
      priority: document.priority,
      idempotencyKey: document.idempotencyKey,
      originalScheduleDate: document.originalScheduleDate,
      scheduledAt: document.scheduledAt,
      claimedAt: document.claimedAt,
      completedAt: document.completedAt,
    };
  }
}
