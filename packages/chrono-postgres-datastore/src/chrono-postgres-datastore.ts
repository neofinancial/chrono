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
import type { DataSource, EntityManager } from 'typeorm';
import { ChronoTaskEntity } from './chrono-task.entity';

const DEFAULT_TABLE_NAME = 'chrono_tasks';

export type ChronoPostgresDatastoreConfig = {
  /**
   * The name of the table to use for storing tasks.
   *
   * @default 'chrono_tasks'
   */
  tableName?: string;
};

export type PostgresDatastoreOptions = {
  /**
   * Optional EntityManager for participating in external transactions.
   * When provided, all operations will use this manager instead of creating new queries.
   */
  entityManager?: EntityManager;
};

type TaskRow = {
  id: string;
  kind: string;
  status: string;
  data: Record<string, unknown>;
  priority: number | null;
  idempotency_key: string | null;
  original_schedule_date: Date;
  scheduled_at: Date;
  claimed_at: Date | null;
  completed_at: Date | null;
  last_executed_at: Date | null;
  retry_count: number;
};

export class ChronoPostgresDatastore<TaskMapping extends TaskMappingBase>
  implements Datastore<TaskMapping, PostgresDatastoreOptions>
{
  private config: Required<ChronoPostgresDatastoreConfig>;
  private dataSource: DataSource | undefined;
  private dataSourceResolvers: Array<(ds: DataSource) => void> = [];

  constructor(config?: ChronoPostgresDatastoreConfig) {
    this.config = {
      tableName: config?.tableName ?? DEFAULT_TABLE_NAME,
    };
  }

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
    const manager = dataSource.manager;

    const { sql, params, errorMessage } = this.buildDeleteQuery(key, options);
    const result = await manager.query(sql, params);

    return this.processDeleteResult<TaskKind>(result, options?.force, errorMessage);
  }

  private buildDeleteQuery<TaskKind extends Extract<keyof TaskMapping, string>>(
    key: DeleteInput<TaskKind>,
    options?: DeleteOptions,
  ): { sql: string; params: unknown[]; errorMessage: string } {
    const tableName = this.config.tableName;
    const statusClause = options?.force ? '' : "AND status = 'PENDING'";

    if (typeof key === 'string') {
      return {
        sql: `DELETE FROM ${tableName} WHERE id = $1 ${statusClause} RETURNING *`,
        params: [key],
        errorMessage: `Task with id ${key} cannot be deleted as it may not exist or it's not in PENDING status.`,
      };
    }

    return {
      sql: `DELETE FROM ${tableName} WHERE kind = $1 AND idempotency_key = $2 ${statusClause} RETURNING *`,
      params: [String(key.kind), key.idempotencyKey],
      errorMessage: `Task with kind ${String(key.kind)} and idempotencyKey ${key.idempotencyKey} cannot be deleted as it may not exist or it's not in PENDING status.`,
    };
  }

  private processDeleteResult<TaskKind extends keyof TaskMapping>(
    result: TaskRow[],
    force: boolean | undefined,
    errorMessage: string,
  ): Task<TaskKind, TaskMapping[TaskKind]> | undefined {
    const [row] = result;
    if (row) {
      return this.toTaskFromRow<TaskKind>(row);
    }

    if (force) {
      return undefined;
    }

    throw new Error(errorMessage);
  }

  async claim<TaskKind extends Extract<keyof TaskMapping, string>>(
    input: ClaimTaskInput<TaskKind>,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]> | undefined> {
    const dataSource = await this.getDataSource();
    const now = new Date();
    const staleThreshold = new Date(now.getTime() - input.claimStaleTimeoutMs);
    const tableName = this.config.tableName;

    // Use FOR UPDATE SKIP LOCKED for atomic claiming without blocking other processors
    const result = await dataSource.manager.query(
      `
      UPDATE ${tableName}
      SET status = $1, claimed_at = $2, updated_at = $2
      WHERE id = (
        SELECT id FROM ${tableName}
        WHERE kind = $3
          AND scheduled_at <= $4
          AND (
            status = 'PENDING'
            OR (status = 'CLAIMED' AND claimed_at <= $5)
          )
        ORDER BY priority DESC, scheduled_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
      `,
      [TaskStatus.CLAIMED, now, String(input.kind), now, staleThreshold],
    );

    if (result.length === 0) {
      return undefined;
    }

    return this.toTaskFromRow<TaskKind>(result[0]);
  }

  async retry<TaskKind extends keyof TaskMapping>(
    taskId: string,
    retryAt: Date,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]>> {
    const now = new Date();
    const sql = `
      UPDATE ${this.config.tableName}
      SET status = $1,
          scheduled_at = $2,
          last_executed_at = $3,
          retry_count = retry_count + 1,
          claimed_at = NULL,
          updated_at = $3
      WHERE id = $4
      RETURNING *
    `;
    return this.updateTaskById<TaskKind>(taskId, sql, [TaskStatus.PENDING, retryAt, now, taskId]);
  }

  async complete<TaskKind extends keyof TaskMapping>(taskId: string): Promise<Task<TaskKind, TaskMapping[TaskKind]>> {
    const now = new Date();
    const sql = `
      UPDATE ${this.config.tableName}
      SET status = $1,
          completed_at = $2,
          last_executed_at = $2,
          updated_at = $2
      WHERE id = $3
      RETURNING *
    `;
    return this.updateTaskById<TaskKind>(taskId, sql, [TaskStatus.COMPLETED, now, taskId]);
  }

  async fail<TaskKind extends keyof TaskMapping>(taskId: string): Promise<Task<TaskKind, TaskMapping[TaskKind]>> {
    const now = new Date();
    const sql = `
      UPDATE ${this.config.tableName}
      SET status = $1,
          last_executed_at = $2,
          updated_at = $2
      WHERE id = $3
      RETURNING *
    `;
    return this.updateTaskById<TaskKind>(taskId, sql, [TaskStatus.FAILED, now, taskId]);
  }

  private async updateTaskById<TaskKind extends keyof TaskMapping>(
    taskId: string,
    sql: string,
    params: unknown[],
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]>> {
    const dataSource = await this.getDataSource();
    const result = await dataSource.manager.query(sql, params);

    if (result.length === 0) {
      throw new Error(`Task with ID ${taskId} not found`);
    }

    return this.toTaskFromRow<TaskKind>(result[0]);
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

  /**
   * Converts a raw database row to a Task object.
   * Used when returning results from raw SQL queries.
   */
  private toTaskFromRow<TaskKind extends keyof TaskMapping>(row: TaskRow): Task<TaskKind, TaskMapping[TaskKind]> {
    return {
      id: row.id,
      kind: row.kind as TaskKind,
      status: row.status as TaskStatus,
      data: row.data as TaskMapping[TaskKind],
      priority: row.priority ?? undefined,
      idempotencyKey: row.idempotency_key ?? undefined,
      originalScheduleDate: new Date(row.original_schedule_date),
      scheduledAt: new Date(row.scheduled_at),
      claimedAt: row.claimed_at ? new Date(row.claimed_at) : undefined,
      completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
      lastExecutedAt: row.last_executed_at ? new Date(row.last_executed_at) : undefined,
      retryCount: row.retry_count,
    };
  }
}
