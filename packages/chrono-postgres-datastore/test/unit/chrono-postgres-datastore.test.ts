import { PGlite } from '@electric-sql/pglite';
import { faker } from '@faker-js/faker';
import { TaskStatus } from '@neofinancial/chrono';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { ChronoPostgresDatastore } from '../../src/chrono-postgres-datastore';
import type { ChronoTaskEntity } from '../../src/chrono-task.entity';
import { TEST_TABLE_NAME } from '../database-setup';

type TaskMapping = {
  test: {
    test: string;
  };
};

const TEST_CLAIM_STALE_TIMEOUT_MS = 1_000; // 1 second

/**
 * Maps a raw database row to a ChronoTaskEntity-like object
 */
function mapRowToEntity(row: Record<string, unknown>): ChronoTaskEntity {
  return {
    id: row.id as string,
    kind: row.kind as string,
    status: row.status as string,
    data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data,
    priority: row.priority as number | null,
    idempotencyKey: row.idempotency_key as string | null,
    originalScheduleDate: new Date(row.original_schedule_date as string),
    scheduledAt: new Date(row.scheduled_at as string),
    claimedAt: row.claimed_at ? new Date(row.claimed_at as string) : null,
    completedAt: row.completed_at ? new Date(row.completed_at as string) : null,
    lastExecutedAt: row.last_executed_at ? new Date(row.last_executed_at as string) : null,
    retryCount: row.retry_count as number,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  } as ChronoTaskEntity;
}

/**
 * Creates a mock QueryBuilder that executes against PGlite
 */
function createMockQueryBuilder(pglite: PGlite, _initialEntity?: typeof ChronoTaskEntity) {
  let operation: 'select' | 'update' | 'delete' = 'select';
  let alias = 'entity';
  const whereClauses: Array<{ sql: string; params: Record<string, unknown> }> = [];
  let setValues: Record<string, unknown> = {};
  let orderByClauses: Array<{ field: string; direction: 'ASC' | 'DESC' }> = [];
  let hasReturning = false;
  let lockMode: string | undefined;

  // Convert camelCase to snake_case
  const toSnakeCase = (str: string): string => {
    return str.replace(/([A-Z])/g, '_$1').toLowerCase();
  };

  // Convert column references from camelCase to snake_case in SQL
  const convertColumnNames = (sql: string): string => {
    // Match word.word patterns (alias.column) and convert column part
    return sql.replace(/(\w+)\.(\w+)/g, (_match, tableAlias, column) => {
      return `${tableAlias}.${toSnakeCase(column)}`;
    });
  };

  const replaceParams = (sql: string, params: Record<string, unknown>): { sql: string; values: unknown[] } => {
    const values: unknown[] = [];
    let paramIndex = 1;
    let result = convertColumnNames(sql);

    for (const [key, value] of Object.entries(params)) {
      const placeholder = `:${key}`;
      if (result.includes(placeholder)) {
        result = result.split(placeholder).join(`$${paramIndex}`);
        values.push(value);
        paramIndex++;
      }
    }

    return { sql: result, values };
  };

  const buildWhereClause = (): { sql: string; values: unknown[] } => {
    if (whereClauses.length === 0) {
      return { sql: '', values: [] };
    }

    const allParams: Record<string, unknown> = {};
    const conditions: string[] = [];

    for (const clause of whereClauses) {
      conditions.push(clause.sql);
      Object.assign(allParams, clause.params);
    }

    const combinedSql = conditions.join(' AND ');
    return replaceParams(combinedSql, allParams);
  };

  const qb = {
    select: () => {
      operation = 'select';
      return qb;
    },
    update: (_entity: typeof ChronoTaskEntity) => {
      operation = 'update';
      return qb;
    },
    delete: () => {
      operation = 'delete';
      return qb;
    },
    from: (_entity: typeof ChronoTaskEntity, entityAlias?: string) => {
      if (entityAlias) alias = entityAlias;
      return qb;
    },
    where: (condition: string | { getQuery: () => string } | unknown, params?: Record<string, unknown>) => {
      if (typeof condition === 'function') {
        // Handle callback style (direct function)
        const bracketsQb = createBracketsQb();
        condition(bracketsQb);
        whereClauses.push({ sql: `(${bracketsQb.getSql()})`, params: bracketsQb.getParams() });
      } else if (typeof condition === 'object' && condition !== null && 'getQuery' in condition) {
        // Handle Brackets object - it has a callback we need to invoke
        const bracketsObj = condition as { getQuery: () => string };
        whereClauses.push({ sql: bracketsObj.getQuery(), params: params || {} });
      } else if (typeof condition === 'string') {
        // Remove alias prefix and convert camelCase column names to snake_case
        // But don't convert parameter placeholders (starting with :)
        let cleanCondition = condition.replace(new RegExp(`${alias}\\.`, 'g'), '');
        // Convert camelCase identifiers to snake_case, but not :param placeholders
        cleanCondition = cleanCondition.replace(/(?<!:)\b([a-z]+)([A-Z][a-z]*)+\b/g, (match) => toSnakeCase(match));
        whereClauses.push({ sql: cleanCondition, params: params || {} });
      }
      return qb;
    },
    andWhere: (condition: string | { getQuery: () => string } | unknown, params?: Record<string, unknown>) => {
      // Handle Brackets object from TypeORM (uses 'whereFactory' property)
      if (typeof condition === 'object' && condition !== null && 'whereFactory' in condition) {
        const bracketsQb = createBracketsQb();
        (condition as { whereFactory: (qb: ReturnType<typeof createBracketsQb>) => void }).whereFactory(bracketsQb);
        whereClauses.push({ sql: `(${bracketsQb.getSql()})`, params: bracketsQb.getParams() });
        return qb;
      }
      return qb.where(condition, params);
    },
    orWhere: (condition: string, params?: Record<string, unknown>) => {
      const cleanCondition = condition.replace(new RegExp(`${alias}\\.`, 'g'), '');
      const lastClause = whereClauses.pop();
      if (lastClause) {
        whereClauses.push({
          sql: `(${lastClause.sql} OR ${cleanCondition})`,
          params: { ...lastClause.params, ...params },
        });
      } else {
        whereClauses.push({ sql: cleanCondition, params: params || {} });
      }
      return qb;
    },
    set: (values: Record<string, unknown>) => {
      setValues = values;
      return qb;
    },
    orderBy: (field: string, direction: 'ASC' | 'DESC' = 'ASC') => {
      const cleanField = field.replace(new RegExp(`${alias}\\.`, 'g'), '');
      orderByClauses = [{ field: cleanField, direction }];
      return qb;
    },
    addOrderBy: (field: string, direction: 'ASC' | 'DESC' = 'ASC') => {
      const cleanField = field.replace(new RegExp(`${alias}\\.`, 'g'), '');
      orderByClauses.push({ field: cleanField, direction });
      return qb;
    },
    limit: (_limit: number) => {
      // Limit is always 1 in our SQL for getOne
      return qb;
    },
    returning: (_columns: string) => {
      hasReturning = true;
      return qb;
    },
    setLock: (mode: string, _version?: unknown, _tables?: string[]) => {
      lockMode = mode;
      return qb;
    },
    getOne: async (): Promise<ChronoTaskEntity | null> => {
      const { sql: whereClause, values } = buildWhereClause();

      let sql = `SELECT * FROM ${TEST_TABLE_NAME}`;
      if (whereClause) {
        sql += ` WHERE ${whereClause}`;
      }
      if (orderByClauses.length > 0) {
        const orderBy = orderByClauses.map((o) => {
          // Convert camelCase to snake_case
          const snakeField = o.field.replace(/([A-Z])/g, '_$1').toLowerCase();
          return `${snakeField} ${o.direction}`;
        });
        sql += ` ORDER BY ${orderBy.join(', ')}`;
      }
      sql += ' LIMIT 1';
      if (lockMode) {
        sql += ' FOR UPDATE SKIP LOCKED';
      }

      const result = await pglite.query(sql, values);
      if (result.rows.length === 0) return null;
      return mapRowToEntity(result.rows[0] as Record<string, unknown>);
    },
    execute: async (): Promise<{ raw: ChronoTaskEntity[]; affected: number }> => {
      const { sql: whereClause, values: whereValues } = buildWhereClause();

      if (operation === 'delete') {
        let sql = `DELETE FROM ${TEST_TABLE_NAME}`;
        if (whereClause) {
          sql += ` WHERE ${whereClause}`;
        }
        if (hasReturning) {
          sql += ' RETURNING *';
        }

        const result = await pglite.query(sql, whereValues);
        const entities = (result.rows as Record<string, unknown>[]).map(mapRowToEntity);
        return { raw: entities, affected: result.rows.length };
      }

      if (operation === 'update') {
        const setClauses: string[] = [];
        const setParamValues: unknown[] = [];
        let paramIndex = whereValues.length + 1;

        for (const [key, value] of Object.entries(setValues)) {
          // Convert camelCase to snake_case
          const snakeKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
          if (typeof value === 'function') {
            // Raw SQL expression like () => 'NULL' or () => 'retry_count + 1'
            const rawValue = value();
            setClauses.push(`${snakeKey} = ${rawValue}`);
          } else {
            setClauses.push(`${snakeKey} = $${paramIndex}`);
            setParamValues.push(value);
            paramIndex++;
          }
        }

        let sql = `UPDATE ${TEST_TABLE_NAME} SET ${setClauses.join(', ')}`;
        if (whereClause) {
          sql += ` WHERE ${whereClause}`;
        }
        if (hasReturning) {
          sql += ' RETURNING *';
        }

        const result = await pglite.query(sql, [...whereValues, ...setParamValues]);
        const entities = (result.rows as Record<string, unknown>[]).map(mapRowToEntity);
        return { raw: entities, affected: result.rows.length };
      }

      return { raw: [], affected: 0 };
    },
  };

  return qb;
}

function createBracketsQb() {
  const conditions: Array<{ type: 'where' | 'or'; sql: string; params: Record<string, unknown> }> = [];

  // Convert camelCase to snake_case
  const toSnakeCase = (str: string): string => {
    return str.replace(/([A-Z])/g, '_$1').toLowerCase();
  };

  const bqb = {
    where: (sql: string, params?: Record<string, unknown>) => {
      conditions.push({ type: 'where', sql, params: params || {} });
      return bqb;
    },
    orWhere: (sql: string, params?: Record<string, unknown>) => {
      conditions.push({ type: 'or', sql, params: params || {} });
      return bqb;
    },
    getSql: (): string => {
      return conditions
        .map((c, i) => {
          // Remove task. prefix and convert camelCase column names to snake_case
          // But don't convert :param placeholders
          let cleanSql = c.sql.replace(/task\./g, '');
          cleanSql = cleanSql.replace(/(?<!:)\b([a-z]+)([A-Z][a-z]*)+\b/g, (match) => toSnakeCase(match));
          if (i === 0) return cleanSql;
          return c.type === 'or' ? `OR ${cleanSql}` : `AND ${cleanSql}`;
        })
        .join(' ');
    },
    getParams: (): Record<string, unknown> => {
      const result: Record<string, unknown> = {};
      for (const c of conditions) {
        Object.assign(result, c.params);
      }
      return result;
    },
  };
  return bqb;
}

/**
 * Creates a mock DataSource that wraps PGlite to provide the interface
 * expected by ChronoPostgresDatastore with QueryBuilder support
 */
function createMockDataSource(pglite: PGlite) {
  const createQueryBuilder = (entity?: typeof ChronoTaskEntity, entityAlias?: string) => {
    const qb = createMockQueryBuilder(pglite, entity);
    if (entityAlias && entity) {
      qb.from(entity, entityAlias);
    }
    return qb;
  };

  const manager = {
    query: async (sql: string, params?: unknown[]) => {
      const result = await pglite.query(sql, params as unknown[]);
      return result.rows;
    },
    create: (_entity: typeof ChronoTaskEntity, data: Partial<ChronoTaskEntity>) => data,
    save: async (_entity: typeof ChronoTaskEntity, data: Partial<ChronoTaskEntity>) => {
      const id = faker.string.uuid();
      const now = new Date();
      const result = await pglite.query(
        `INSERT INTO ${TEST_TABLE_NAME}
         (id, kind, status, data, priority, idempotency_key, original_schedule_date, scheduled_at, retry_count, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          id,
          data.kind,
          data.status,
          JSON.stringify(data.data),
          data.priority ?? 0,
          data.idempotencyKey ?? null,
          data.originalScheduleDate,
          data.scheduledAt,
          data.retryCount ?? 0,
          now,
          now,
        ],
      );
      return mapRowToEntity(result.rows[0] as Record<string, unknown>);
    },
    findOne: async (_entity: typeof ChronoTaskEntity, options: { where: Partial<ChronoTaskEntity> }) => {
      const where = options.where;
      let sql = `SELECT * FROM ${TEST_TABLE_NAME} WHERE 1=1`;
      const params: unknown[] = [];
      let paramIndex = 1;

      if (where.id) {
        sql += ` AND id = $${paramIndex++}`;
        params.push(where.id);
      }
      if (where.idempotencyKey) {
        sql += ` AND idempotency_key = $${paramIndex++}`;
        params.push(where.idempotencyKey);
      }
      sql += ' LIMIT 1';

      const result = await pglite.query(sql, params);
      if (result.rows.length === 0) return null;
      return mapRowToEntity(result.rows[0] as Record<string, unknown>);
    },
    createQueryBuilder,
  };

  return {
    manager,
    isInitialized: true,
    destroy: async () => {},
    createQueryBuilder,
    transaction: async <T>(work: (manager: typeof manager) => Promise<T>): Promise<T> => {
      // PGlite doesn't support real transactions in the same way,
      // but for testing purposes we can just execute the work
      return work(manager);
    },
  };
}

describe('ChronoPostgresDatastore', () => {
  let pglite: PGlite;
  let mockDataSource: ReturnType<typeof createMockDataSource>;
  let dataStore: ChronoPostgresDatastore<TaskMapping>;

  beforeAll(async () => {
    // Create in-memory PGlite instance
    pglite = new PGlite();

    // Create the table schema
    await pglite.exec(`
      CREATE TABLE IF NOT EXISTS ${TEST_TABLE_NAME} (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        kind VARCHAR(255) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        data JSONB NOT NULL,
        priority INTEGER DEFAULT 0,
        idempotency_key VARCHAR(255),
        original_schedule_date TIMESTAMP WITH TIME ZONE NOT NULL,
        scheduled_at TIMESTAMP WITH TIME ZONE NOT NULL,
        claimed_at TIMESTAMP WITH TIME ZONE,
        completed_at TIMESTAMP WITH TIME ZONE,
        last_executed_at TIMESTAMP WITH TIME ZONE,
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )
    `);

    // Create indexes
    await pglite.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_chrono_tasks_idempotency_key
      ON ${TEST_TABLE_NAME} (idempotency_key)
      WHERE idempotency_key IS NOT NULL
    `);

    mockDataSource = createMockDataSource(pglite);

    dataStore = new ChronoPostgresDatastore({});

    await dataStore.initialize(mockDataSource as unknown as Parameters<typeof dataStore.initialize>[0]);
  });

  beforeEach(async () => {
    await pglite.exec(`DELETE FROM ${TEST_TABLE_NAME}`);
  });

  afterAll(async () => {
    await pglite.close();
  });

  describe('initialize', () => {
    test('should throw an error if the DataSource is already set', async () => {
      await expect(() =>
        dataStore.initialize(mockDataSource as unknown as Parameters<typeof dataStore.initialize>[0]),
      ).rejects.toThrow('DataSource already initialized');
    });
  });

  describe('schedule', () => {
    const input = {
      kind: 'test' as const,
      data: { test: 'test' },
      priority: 1,
      when: new Date(),
    };

    describe('when called with valid input', () => {
      test('should return task with correct properties', async () => {
        const task = await dataStore.schedule(input);

        expect(task).toEqual(
          expect.objectContaining({
            kind: input.kind,
            status: 'PENDING',
            data: input.data,
            priority: input.priority,
            originalScheduleDate: expect.any(Date),
            scheduledAt: expect.any(Date),
            id: expect.any(String),
            retryCount: 0,
          }),
        );
      });

      test('should store task in the database', async () => {
        const task = await dataStore.schedule(input);

        const result = await pglite.query(`SELECT * FROM ${TEST_TABLE_NAME} WHERE id = $1`, [task.id]);

        expect(result.rows.length).toBe(1);
        expect(result.rows[0]).toEqual(
          expect.objectContaining({
            kind: input.kind,
            status: 'PENDING',
          }),
        );
      });
    });

    describe('idempotency', () => {
      test('should return existing task if one exists with same idempotency key', async () => {
        const idempotencyKey = faker.string.uuid();
        const inputWithIdempotency = {
          kind: 'test' as const,
          data: { test: 'test' },
          priority: 1,
          when: new Date(),
          idempotencyKey,
        };

        const task1 = await dataStore.schedule(inputWithIdempotency);
        const task2 = await dataStore.schedule(inputWithIdempotency);

        expect(task1.id).toEqual(task2.id);
        expect(task1.idempotencyKey).toEqual(task2.idempotencyKey);
      });
    });
  });

  describe('claim', () => {
    const input = {
      kind: 'test' as const,
      data: { test: 'test' },
      priority: 1,
      when: new Date(Date.now() - 1),
    };

    test('should return undefined when no tasks available', async () => {
      const result = await dataStore.claim({
        kind: input.kind,
        claimStaleTimeoutMs: TEST_CLAIM_STALE_TIMEOUT_MS,
      });

      expect(result).toBeUndefined();
    });

    test('should claim task in PENDING state with scheduledAt in the past', async () => {
      const task = await dataStore.schedule({
        ...input,
        when: new Date(Date.now() - 1000),
      });

      const claimedTask = await dataStore.claim({
        kind: input.kind,
        claimStaleTimeoutMs: TEST_CLAIM_STALE_TIMEOUT_MS,
      });

      expect(claimedTask).toEqual(
        expect.objectContaining({
          id: task.id,
          kind: task.kind,
          status: 'CLAIMED',
        }),
      );
    });

    test('should claim task in CLAIMED state with claimedAt in the past (stale)', async () => {
      const scheduledTask = await dataStore.schedule(input);

      const claimedTask = await dataStore.claim({
        kind: input.kind,
        claimStaleTimeoutMs: TEST_CLAIM_STALE_TIMEOUT_MS,
      });

      // Trying to claim again should return undefined (no stale tasks)
      const claimedTaskAgain = await dataStore.claim({
        kind: input.kind,
        claimStaleTimeoutMs: TEST_CLAIM_STALE_TIMEOUT_MS,
      });

      // Fast forward time to make the claim stale
      const fakeTimer = vi.useFakeTimers();
      fakeTimer.setSystemTime(
        new Date((claimedTask?.claimedAt?.getTime() as number) + TEST_CLAIM_STALE_TIMEOUT_MS + 1),
      );

      const claimedTaskAgainAgain = await dataStore.claim({
        kind: input.kind,
        claimStaleTimeoutMs: TEST_CLAIM_STALE_TIMEOUT_MS,
      });
      fakeTimer.useRealTimers();

      expect(scheduledTask).toEqual(
        expect.objectContaining({
          status: TaskStatus.PENDING,
        }),
      );
      expect(claimedTask).toEqual(
        expect.objectContaining({
          id: scheduledTask.id,
          kind: scheduledTask.kind,
          status: TaskStatus.CLAIMED,
        }),
      );
      expect(claimedTaskAgain).toBeUndefined();
      expect(claimedTaskAgainAgain).toEqual(
        expect.objectContaining({
          id: scheduledTask.id,
          kind: scheduledTask.kind,
          status: TaskStatus.CLAIMED,
        }),
      );
    });

    test('should claim tasks in priority order (higher priority first)', async () => {
      const lowPriorityTask = await dataStore.schedule({
        ...input,
        priority: 1,
      });
      const highPriorityTask = await dataStore.schedule({
        ...input,
        priority: 10,
      });

      const firstClaimed = await dataStore.claim({
        kind: input.kind,
        claimStaleTimeoutMs: TEST_CLAIM_STALE_TIMEOUT_MS,
      });

      expect(firstClaimed?.id).toEqual(highPriorityTask.id);

      const secondClaimed = await dataStore.claim({
        kind: input.kind,
        claimStaleTimeoutMs: TEST_CLAIM_STALE_TIMEOUT_MS,
      });

      expect(secondClaimed?.id).toEqual(lowPriorityTask.id);
    });
  });

  describe('complete', () => {
    test('should mark task as completed', async () => {
      const task = await dataStore.schedule({
        kind: 'test',
        data: { test: 'test' },
        priority: 1,
        when: new Date(),
      });

      const completedTask = await dataStore.complete(task.id);

      expect(completedTask).toEqual(
        expect.objectContaining({
          id: task.id,
          kind: task.kind,
          status: TaskStatus.COMPLETED,
          completedAt: expect.any(Date),
        }),
      );

      // Verify in database
      const result = await pglite.query(`SELECT * FROM ${TEST_TABLE_NAME} WHERE id = $1`, [task.id]);
      expect(result.rows[0]).toEqual(
        expect.objectContaining({
          status: TaskStatus.COMPLETED,
        }),
      );
    });

    test('should throw an error if task is not found', async () => {
      const taskId = faker.string.uuid();

      await expect(() => dataStore.complete(taskId)).rejects.toThrow(`Task with ID ${taskId} not found`);
    });
  });

  describe('fail', () => {
    test('should mark task as failed', async () => {
      const task = await dataStore.schedule({
        kind: 'test',
        data: { test: 'test' },
        priority: 1,
        when: new Date(),
      });

      const failedTask = await dataStore.fail(task.id);

      expect(failedTask).toEqual(
        expect.objectContaining({
          id: task.id,
          kind: task.kind,
          status: TaskStatus.FAILED,
        }),
      );

      // Verify in database
      const result = await pglite.query(`SELECT * FROM ${TEST_TABLE_NAME} WHERE id = $1`, [task.id]);
      expect(result.rows[0]).toEqual(
        expect.objectContaining({
          status: TaskStatus.FAILED,
        }),
      );
    });

    test('should throw an error if task is not found', async () => {
      const taskId = faker.string.uuid();

      await expect(() => dataStore.fail(taskId)).rejects.toThrow(`Task with ID ${taskId} not found`);
    });
  });

  describe('retry', () => {
    test('should retry task', async () => {
      const firstScheduleDate = faker.date.past();
      const secondScheduleDate = faker.date.future();

      const task = await dataStore.schedule({
        kind: 'test',
        data: { test: 'test' },
        priority: 1,
        when: firstScheduleDate,
      });

      expect(task).toEqual(
        expect.objectContaining({
          status: TaskStatus.PENDING,
          retryCount: 0,
        }),
      );

      const taskToRetry = await dataStore.retry(task.id, secondScheduleDate);

      expect(taskToRetry).toEqual(
        expect.objectContaining({
          id: task.id,
          kind: task.kind,
          status: TaskStatus.PENDING,
          retryCount: 1,
        }),
      );

      // Verify scheduledAt was updated
      expect(taskToRetry.scheduledAt.getTime()).toBeCloseTo(secondScheduleDate.getTime(), -3);
      // Verify originalScheduleDate was preserved
      expect(taskToRetry.originalScheduleDate.getTime()).toBeCloseTo(firstScheduleDate.getTime(), -3);
    });

    test('should throw an error if task is not found', async () => {
      const taskId = faker.string.uuid();

      await expect(() => dataStore.retry(taskId, new Date())).rejects.toThrow(`Task with ID ${taskId} not found`);
    });
  });

  describe('delete', () => {
    test('deletes task by id removing from datastore', async () => {
      const when = new Date();

      const task = await dataStore.schedule({
        kind: 'test',
        data: { test: 'test' },
        priority: 1,
        when,
      });

      await dataStore.delete(task.id);

      const result = await pglite.query(`SELECT * FROM ${TEST_TABLE_NAME} WHERE id = $1`, [task.id]);
      expect(result.rows.length).toBe(0);
    });

    test('deletes task by task kind and idempotency key removing from datastore', async () => {
      const when = new Date();

      const task = await dataStore.schedule({
        idempotencyKey: 'test-idempotency-key',
        kind: 'test',
        data: { test: 'test' },
        priority: 1,
        when,
      });

      await dataStore.delete({ kind: task.kind, idempotencyKey: task.idempotencyKey ?? 'undefined' });

      const result = await pglite.query(`SELECT * FROM ${TEST_TABLE_NAME} WHERE id = $1`, [task.id]);
      expect(result.rows.length).toBe(0);
    });

    test('returns deleted task', async () => {
      const when = new Date();

      const task = await dataStore.schedule({
        kind: 'test',
        data: { test: 'test' },
        priority: 1,
        when,
      });

      const deletedTask = await dataStore.delete(task.id);

      expect(deletedTask?.id).toEqual(task.id);
      expect(deletedTask?.kind).toEqual(task.kind);
    });

    test('throws when attempting to delete a task that is not PENDING', async () => {
      const when = new Date(Date.now() - 1000);

      const task = await dataStore.schedule({
        kind: 'test',
        data: { test: 'test' },
        priority: 1,
        when,
      });

      await dataStore.claim({ kind: task.kind, claimStaleTimeoutMs: TEST_CLAIM_STALE_TIMEOUT_MS });

      await expect(dataStore.delete(task.id)).rejects.toThrow(
        `Task with id ${task.id} cannot be deleted as it may not exist or it's not in PENDING status.`,
      );
    });

    test('force deletes non-PENDING task removing from datastore', async () => {
      const when = new Date(Date.now() - 1000);

      const task = await dataStore.schedule({
        kind: 'test',
        data: { test: 'test' },
        priority: 1,
        when,
      });

      await dataStore.claim({ kind: task.kind, claimStaleTimeoutMs: TEST_CLAIM_STALE_TIMEOUT_MS });

      await dataStore.delete(task.id, { force: true });

      const result = await pglite.query(`SELECT * FROM ${TEST_TABLE_NAME} WHERE id = $1`, [task.id]);
      expect(result.rows.length).toBe(0);
    });

    test('noops when force deleting a task that does not exist', async () => {
      const result = await dataStore.delete(faker.string.uuid(), { force: true });
      expect(result).toBeUndefined();
    });
  });

  describe('getEntity', () => {
    test('should return the ChronoTaskEntity class', () => {
      const entity = ChronoPostgresDatastore.getEntity();
      expect(entity.name).toBe('ChronoTaskEntity');
    });
  });
});
