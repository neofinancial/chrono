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
import type { Pool, PoolClient } from 'pg';
import {
  CLAIM_QUERY,
  CLEANUP_QUERY,
  COMPLETE_QUERY,
  DELETE_BY_ID_FORCE_QUERY,
  DELETE_BY_ID_QUERY,
  DELETE_BY_KEY_FORCE_QUERY,
  DELETE_BY_KEY_QUERY,
  FAIL_QUERY,
  FIND_BY_IDEMPOTENCY_KEY_QUERY,
  RETRY_QUERY,
  SCHEDULE_QUERY,
} from './queries';
import type { ChronoTaskRow } from './types';

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30;
const DEFAULT_CLEANUP_INTERVAL_SECONDS = 60;
const DEFAULT_CLEANUP_BATCH_SIZE = 100;
const DEFAULT_INITIALIZATION_TIMEOUT_MS = 10_000;

export type ChronoPostgresDatastoreConfig = {
  /** TTL (in seconds) for completed tasks. Tasks older than this are deleted during cleanup. */
  completedDocumentTTLSeconds?: number;

  /** How often (in seconds) to attempt cleanup. Runs opportunistically after claim() calls. */
  cleanupIntervalSeconds?: number;

  /** Max completed tasks to delete per cleanup run. */
  cleanupBatchSize?: number;

  /** Called when cleanup fails. Use this to report errors to Sentry, logging, etc. */
  onCleanupError?: (error: unknown) => void;

  /**
   * Timeout (in milliseconds) for waiting for datastore initialization.
   * If the datastore is not initialized within this time, operations will throw an error.
   * Default: 10000ms (10 seconds)
   */
  initializationTimeoutMs?: number;
};

export type PostgresDatastoreOptions = {
  /**
   * Optional PoolClient for participating in external transactions.
   * When provided, all operations will use this client instead of acquiring from the pool.
   */
  client?: PoolClient;
};

type ResolvedConfig = Required<Omit<ChronoPostgresDatastoreConfig, 'onCleanupError'>> &
  Pick<ChronoPostgresDatastoreConfig, 'onCleanupError'>;

export class ChronoPostgresDatastore<TaskMapping extends TaskMappingBase>
  implements Datastore<TaskMapping, PostgresDatastoreOptions>
{
  private config: ResolvedConfig;
  private pool: Pool | undefined;
  private poolResolvers: Array<(pool: Pool) => void> = [];
  private lastCleanupTime: Date = new Date(0);

  constructor(config?: ChronoPostgresDatastoreConfig) {
    this.config = {
      completedDocumentTTLSeconds: config?.completedDocumentTTLSeconds ?? DEFAULT_TTL_SECONDS,
      cleanupIntervalSeconds: config?.cleanupIntervalSeconds ?? DEFAULT_CLEANUP_INTERVAL_SECONDS,
      cleanupBatchSize: config?.cleanupBatchSize ?? DEFAULT_CLEANUP_BATCH_SIZE,
      onCleanupError: config?.onCleanupError,
      initializationTimeoutMs: config?.initializationTimeoutMs ?? DEFAULT_INITIALIZATION_TIMEOUT_MS,
    };
  }

  /**
   * Initializes the datastore with a pg Pool.
   * Must be called before any operations can be performed.
   *
   * @param pool - The pg Pool connected to PostgreSQL
   */
  async initialize(pool: Pool): Promise<void> {
    if (this.pool) {
      throw new Error('Pool already initialized');
    }

    this.pool = pool;

    // Resolve any pending operations waiting for the pool
    const resolvers = this.poolResolvers.splice(0);
    for (const resolve of resolvers) {
      resolve(pool);
    }
  }

  /**
   * Asynchronously gets the Pool. If not yet initialized,
   * waits for initialize() to be called with a timeout.
   * @throws Error if initialization times out
   */
  private async getPool(): Promise<Pool> {
    if (this.pool) {
      return this.pool;
    }

    const initPromise = new Promise<Pool>((resolve) => {
      this.poolResolvers.push(resolve);
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(
          new Error(
            `ChronoPostgresDatastore initialization timeout: datastore was not initialized within ${this.config.initializationTimeoutMs}ms. ` +
              'Ensure initialize() is called before performing operations.',
          ),
        );
      }, this.config.initializationTimeoutMs);
    });

    return Promise.race([initPromise, timeoutPromise]);
  }

  /**
   * Gets the client to use for operations.
   * Uses the provided client from options if available, otherwise uses the pool.
   */
  private getQueryable(options?: PostgresDatastoreOptions): Pool | PoolClient {
    if (options?.client) {
      return options.client;
    }

    if (!this.pool) {
      throw new Error('Pool not initialized');
    }

    return this.pool;
  }

  async schedule<TaskKind extends keyof TaskMapping>(
    input: ScheduleInput<TaskKind, TaskMapping[TaskKind], PostgresDatastoreOptions>,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]>> {
    await this.getPool();
    const queryable = this.getQueryable(input.datastoreOptions);

    const values = [
      String(input.kind),
      TaskStatus.PENDING,
      JSON.stringify(input.data),
      input.priority ?? 0,
      input.idempotencyKey ?? null,
      input.when,
      input.when,
      0,
    ];

    try {
      const result = await queryable.query<ChronoTaskRow>(SCHEDULE_QUERY, values);
      const row = result.rows[0];
      if (!row) {
        throw new Error('Failed to insert task: no row returned');
      }
      return this.toTask<TaskKind>(row);
    } catch (error) {
      return this.handleScheduleError<TaskKind>(error, input.idempotencyKey, queryable);
    }
  }

  private async handleScheduleError<TaskKind extends keyof TaskMapping>(
    error: unknown,
    idempotencyKey: string | undefined,
    queryable: Pool | PoolClient,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]>> {
    const isIdempotencyConflict = this.isUniqueViolation(error) && idempotencyKey;
    if (!isIdempotencyConflict) {
      throw error;
    }

    const result = await queryable.query<ChronoTaskRow>(FIND_BY_IDEMPOTENCY_KEY_QUERY, [idempotencyKey]);
    const row = result.rows[0];

    if (!row) {
      throw new Error(
        `Failed to find existing task with idempotency key ${idempotencyKey} despite unique constraint error`,
      );
    }

    return this.toTask<TaskKind>(row);
  }

  async delete<TaskKind extends Extract<keyof TaskMapping, string>>(
    key: DeleteInput<TaskKind>,
    options?: DeleteOptions,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]> | undefined> {
    const pool = await this.getPool();

    let query: string;
    let values: unknown[];

    if (typeof key === 'string') {
      if (options?.force) {
        query = DELETE_BY_ID_FORCE_QUERY;
        values = [key];
      } else {
        query = DELETE_BY_ID_QUERY;
        values = [key, TaskStatus.PENDING];
      }
    } else {
      if (options?.force) {
        query = DELETE_BY_KEY_FORCE_QUERY;
        values = [String(key.kind), key.idempotencyKey];
      } else {
        query = DELETE_BY_KEY_QUERY;
        values = [String(key.kind), key.idempotencyKey, TaskStatus.PENDING];
      }
    }

    const result = await pool.query<ChronoTaskRow>(query, values);
    const row = result.rows[0];

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
    const pool = await this.getPool();
    const now = new Date();
    const staleThreshold = new Date(now.getTime() - input.claimStaleTimeoutMs);

    // Single atomic query: SELECT FOR UPDATE SKIP LOCKED + UPDATE in one statement
    const result = await pool.query<ChronoTaskRow>(CLAIM_QUERY, [
      TaskStatus.CLAIMED,
      now,
      String(input.kind),
      TaskStatus.PENDING,
      staleThreshold,
    ]);

    // Opportunistic cleanup runs after claim completes
    this.maybeCleanupCompletedTasks();

    const row = result.rows[0];
    return row ? this.toTask<TaskKind>(row) : undefined;
  }

  async retry<TaskKind extends keyof TaskMapping>(
    taskId: string,
    retryAt: Date,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]>> {
    const pool = await this.getPool();
    const now = new Date();

    const result = await pool.query<ChronoTaskRow>(RETRY_QUERY, [TaskStatus.PENDING, retryAt, now, taskId]);

    return this.extractUpdatedTaskOrThrow<TaskKind>(result.rows, taskId);
  }

  async complete<TaskKind extends keyof TaskMapping>(taskId: string): Promise<Task<TaskKind, TaskMapping[TaskKind]>> {
    const pool = await this.getPool();
    const now = new Date();

    const result = await pool.query<ChronoTaskRow>(COMPLETE_QUERY, [TaskStatus.COMPLETED, now, now, now, taskId]);

    return this.extractUpdatedTaskOrThrow<TaskKind>(result.rows, taskId);
  }

  async fail<TaskKind extends keyof TaskMapping>(taskId: string): Promise<Task<TaskKind, TaskMapping[TaskKind]>> {
    const pool = await this.getPool();
    const now = new Date();

    const result = await pool.query<ChronoTaskRow>(FAIL_QUERY, [TaskStatus.FAILED, now, now, taskId]);

    return this.extractUpdatedTaskOrThrow<TaskKind>(result.rows, taskId);
  }

  private extractUpdatedTaskOrThrow<TaskKind extends keyof TaskMapping>(
    rows: ChronoTaskRow[],
    taskId: string,
  ): Task<TaskKind, TaskMapping[TaskKind]> {
    const row = rows[0];
    if (!row) {
      throw new Error(`Task with ID ${taskId} not found`);
    }
    return this.toTask<TaskKind>(row);
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
   * Converts a database row to a Task object.
   */
  private toTask<TaskKind extends keyof TaskMapping>(row: ChronoTaskRow): Task<TaskKind, TaskMapping[TaskKind]> {
    return {
      id: row.id,
      kind: row.kind as TaskKind,
      status: row.status as TaskStatus,
      data: row.data as TaskMapping[TaskKind],
      priority: row.priority ?? undefined,
      idempotencyKey: row.idempotency_key ?? undefined,
      originalScheduleDate: row.original_schedule_date,
      scheduledAt: row.scheduled_at,
      claimedAt: row.claimed_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      lastExecutedAt: row.last_executed_at ?? undefined,
      retryCount: row.retry_count,
    };
  }

  /**
   * Opportunistically cleans up old completed tasks.
   * Runs in the background (fire-and-forget) to avoid blocking claim().
   * Multiple instances may race; this is harmless as DELETE is idempotent.
   */
  private maybeCleanupCompletedTasks(): void {
    const now = new Date();
    const timeSinceLastCleanup = now.getTime() - this.lastCleanupTime.getTime();

    if (timeSinceLastCleanup < this.config.cleanupIntervalSeconds * 1000) {
      return;
    }

    // Update timestamp before cleanup to prevent concurrent cleanup attempts from this instance
    this.lastCleanupTime = now;

    this.cleanupCompletedTasks().catch((error) => {
      this.config.onCleanupError?.(error);
    });
  }

  private async cleanupCompletedTasks(): Promise<void> {
    const pool = this.pool;
    if (!pool) {
      return;
    }

    const cutoffDate = new Date(Date.now() - this.config.completedDocumentTTLSeconds * 1000);

    // Single atomic query: DELETE with LIMIT via subquery
    await pool.query(CLEANUP_QUERY, [TaskStatus.COMPLETED, cutoffDate, this.config.cleanupBatchSize]);
  }
}
