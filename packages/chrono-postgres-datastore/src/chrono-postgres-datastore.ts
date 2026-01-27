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
import { Brackets, type DataSource, type EntityManager } from 'typeorm';
import { ChronoTaskEntity } from './chrono-task.entity';

/** @deprecated Config is no longer used - table name is determined by the entity */
export type ChronoPostgresDatastoreConfig = Record<string, never>;

export type PostgresDatastoreOptions = {
  /**
   * Optional EntityManager for participating in external transactions.
   * When provided, all operations will use this manager instead of creating new queries.
   */
  entityManager?: EntityManager;
};

export class ChronoPostgresDatastore<TaskMapping extends TaskMappingBase>
  implements Datastore<TaskMapping, PostgresDatastoreOptions>
{
  private dataSource: DataSource | undefined;
  private dataSourceResolvers: Array<(ds: DataSource) => void> = [];

  /**
   * Initializes the datastore with a TypeORM DataSource.
   * Must be called before any operations can be performed.
   *
   * @param dataSource - The TypeORM DataSource connected to PostgreSQL
   */
  async initialize(dataSource: DataSource): Promise<void> {
    if (this.dataSource) {
      throw new Error('DataSource already initialized');
    }

    this.dataSource = dataSource;

    // Resolve any pending operations waiting for the dataSource
    const resolvers = this.dataSourceResolvers.splice(0);
    for (const resolve of resolvers) {
      resolve(dataSource);
    }
  }

  /**
   * Returns the entity class for use with TypeORM.
   * Useful for registering the entity with a DataSource.
   */
  static getEntity(): typeof ChronoTaskEntity {
    return ChronoTaskEntity;
  }

  /**
   * Asynchronously gets the DataSource. If not yet initialized,
   * returns a promise that resolves when initialize() is called.
   */
  private async getDataSource(): Promise<DataSource> {
    if (this.dataSource) {
      return this.dataSource;
    }

    return new Promise<DataSource>((resolve) => {
      this.dataSourceResolvers.push(resolve);
    });
  }

  /**
   * Gets the EntityManager to use for operations.
   * Uses the provided manager from options if available, otherwise uses the DataSource's manager.
   */
  private getManager(options?: PostgresDatastoreOptions): EntityManager {
    if (options?.entityManager) {
      return options.entityManager;
    }

    if (!this.dataSource) {
      throw new Error('DataSource not initialized');
    }

    return this.dataSource.manager;
  }

  async schedule<TaskKind extends keyof TaskMapping>(
    input: ScheduleInput<TaskKind, TaskMapping[TaskKind], PostgresDatastoreOptions>,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]>> {
    await this.getDataSource();
    const manager = this.getManager(input.datastoreOptions);

    const entity = manager.create(ChronoTaskEntity, {
      kind: String(input.kind),
      status: TaskStatus.PENDING,
      data: input.data as Record<string, unknown>,
      priority: input.priority ?? 0,
      idempotencyKey: input.idempotencyKey ?? null,
      originalScheduleDate: input.when,
      scheduledAt: input.when,
      retryCount: 0,
    });

    try {
      const saved = await manager.save(ChronoTaskEntity, entity);
      return this.toTask<TaskKind>(saved);
    } catch (error) {
      return this.handleScheduleError<TaskKind>(error, input.idempotencyKey, manager);
    }
  }

  private async handleScheduleError<TaskKind extends keyof TaskMapping>(
    error: unknown,
    idempotencyKey: string | undefined,
    manager: EntityManager,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]>> {
    const isIdempotencyConflict = this.isUniqueViolation(error) && idempotencyKey;
    if (!isIdempotencyConflict) {
      throw error;
    }

    const existing = await manager.findOne(ChronoTaskEntity, {
      where: { idempotencyKey },
    });

    if (!existing) {
      throw new Error(
        `Failed to find existing task with idempotency key ${idempotencyKey} despite unique constraint error`,
      );
    }

    return this.toTask<TaskKind>(existing);
  }

  async delete<TaskKind extends Extract<keyof TaskMapping, string>>(
    key: DeleteInput<TaskKind>,
    options?: DeleteOptions,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]> | undefined> {
    const dataSource = await this.getDataSource();

    const qb = dataSource.createQueryBuilder().delete().from(ChronoTaskEntity).returning('*');

    if (typeof key === 'string') {
      qb.where('id = :id', { id: key });
    } else {
      qb.where('kind = :kind AND idempotency_key = :idempotencyKey', {
        kind: String(key.kind),
        idempotencyKey: key.idempotencyKey,
      });
    }

    if (!options?.force) {
      qb.andWhere('status = :status', { status: TaskStatus.PENDING });
    }

    const result = await qb.execute();
    const [row] = result.raw as ChronoTaskEntity[];

    if (row) {
      return this.toTask<TaskKind>(row);
    }

    if (options?.force) {
      return undefined;
    }

    throw new Error(this.buildDeleteErrorMessage(key));
  }

  private buildDeleteErrorMessage<TaskKind extends Extract<keyof TaskMapping, string>>(
    key: DeleteInput<TaskKind>,
  ): string {
    if (typeof key === 'string') {
      return `Task with id ${key} cannot be deleted as it may not exist or it's not in PENDING status.`;
    }
    return `Task with kind ${String(key.kind)} and idempotencyKey ${key.idempotencyKey} cannot be deleted as it may not exist or it's not in PENDING status.`;
  }

  async claim<TaskKind extends Extract<keyof TaskMapping, string>>(
    input: ClaimTaskInput<TaskKind>,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]> | undefined> {
    const dataSource = await this.getDataSource();
    const now = new Date();
    const staleThreshold = new Date(now.getTime() - input.claimStaleTimeoutMs);

    // Use a transaction to atomically select and update
    return dataSource.transaction(async (manager) => {
      // Find and lock the next claimable task
      const taskToClaimQuery = manager
        .createQueryBuilder(ChronoTaskEntity, 'task')
        .where('task.kind = :kind', { kind: String(input.kind) })
        .andWhere('task.scheduledAt <= :now', { now })
        .andWhere(
          new Brackets((qb) => {
            qb.where('task.status = :pending', { pending: TaskStatus.PENDING }).orWhere(
              'task.status = :claimed AND task.claimedAt <= :staleThreshold',
              { claimed: TaskStatus.CLAIMED, staleThreshold },
            );
          }),
        )
        .orderBy('task.priority', 'DESC')
        .addOrderBy('task.scheduledAt', 'ASC')
        .limit(1)
        .setLock('pessimistic_write', undefined, ['skipLocked']);

      const taskToClaim = await taskToClaimQuery.getOne();

      if (!taskToClaim) {
        return undefined;
      }

      // Update the task to claim it
      const updateResult = await manager
        .createQueryBuilder()
        .update(ChronoTaskEntity)
        .set({
          status: TaskStatus.CLAIMED,
          claimedAt: now,
          updatedAt: now,
        })
        .where('id = :id', { id: taskToClaim.id })
        .returning('*')
        .execute();

      const [claimedTask] = updateResult.raw as ChronoTaskEntity[];
      return claimedTask ? this.toTask<TaskKind>(claimedTask) : undefined;
    });
  }

  async retry<TaskKind extends keyof TaskMapping>(
    taskId: string,
    retryAt: Date,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]>> {
    const dataSource = await this.getDataSource();
    const now = new Date();

    const result = await dataSource
      .createQueryBuilder()
      .update(ChronoTaskEntity)
      .set({
        status: TaskStatus.PENDING,
        scheduledAt: retryAt,
        lastExecutedAt: now,
        claimedAt: () => 'NULL',
        updatedAt: now,
        retryCount: () => 'retry_count + 1',
      })
      .where('id = :id', { id: taskId })
      .returning('*')
      .execute();

    return this.extractUpdatedTaskOrThrow<TaskKind>(result.raw, taskId);
  }

  async complete<TaskKind extends keyof TaskMapping>(taskId: string): Promise<Task<TaskKind, TaskMapping[TaskKind]>> {
    const dataSource = await this.getDataSource();
    const now = new Date();

    const result = await dataSource
      .createQueryBuilder()
      .update(ChronoTaskEntity)
      .set({
        status: TaskStatus.COMPLETED,
        completedAt: now,
        lastExecutedAt: now,
        updatedAt: now,
      })
      .where('id = :id', { id: taskId })
      .returning('*')
      .execute();

    return this.extractUpdatedTaskOrThrow<TaskKind>(result.raw, taskId);
  }

  async fail<TaskKind extends keyof TaskMapping>(taskId: string): Promise<Task<TaskKind, TaskMapping[TaskKind]>> {
    const dataSource = await this.getDataSource();
    const now = new Date();

    const result = await dataSource
      .createQueryBuilder()
      .update(ChronoTaskEntity)
      .set({
        status: TaskStatus.FAILED,
        lastExecutedAt: now,
        updatedAt: now,
      })
      .where('id = :id', { id: taskId })
      .returning('*')
      .execute();

    return this.extractUpdatedTaskOrThrow<TaskKind>(result.raw, taskId);
  }

  private extractUpdatedTaskOrThrow<TaskKind extends keyof TaskMapping>(
    raw: ChronoTaskEntity[],
    taskId: string,
  ): Task<TaskKind, TaskMapping[TaskKind]> {
    const [entity] = raw;
    if (!entity) {
      throw new Error(`Task with ID ${taskId} not found`);
    }
    return this.toTask<TaskKind>(entity);
  }

  /**
   * Checks if an error is a PostgreSQL unique constraint violation.
   */
  private isUniqueViolation(error: unknown): boolean {
    const PG_UNIQUE_VIOLATION = '23505';
    const isErrorObject = typeof error === 'object' && error !== null;
    return isErrorObject && 'code' in error && error.code === PG_UNIQUE_VIOLATION;
  }

  /**
   * Converts a ChronoTaskEntity to a Task object.
   */
  private toTask<TaskKind extends keyof TaskMapping>(entity: ChronoTaskEntity): Task<TaskKind, TaskMapping[TaskKind]> {
    return {
      id: entity.id,
      kind: entity.kind as TaskKind,
      status: entity.status as TaskStatus,
      data: entity.data as TaskMapping[TaskKind],
      priority: entity.priority ?? undefined,
      idempotencyKey: entity.idempotencyKey ?? undefined,
      originalScheduleDate: entity.originalScheduleDate,
      scheduledAt: entity.scheduledAt,
      claimedAt: entity.claimedAt ?? undefined,
      completedAt: entity.completedAt ?? undefined,
      lastExecutedAt: entity.lastExecutedAt ?? undefined,
      retryCount: entity.retryCount,
    };
  }
}
