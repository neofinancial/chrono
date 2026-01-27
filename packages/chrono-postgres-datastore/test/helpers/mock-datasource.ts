import type { PGlite } from '@electric-sql/pglite';
import { faker } from '@faker-js/faker';

import type { ChronoTaskEntity } from '../../src/chrono-task.entity';
import { TEST_TABLE_NAME } from '../database-setup';

/**
 * Maps a raw database row to a ChronoTaskEntity-like object
 */
export function mapRowToEntity(row: Record<string, unknown>): ChronoTaskEntity {
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
 * Convert camelCase to snake_case
 */
function toSnakeCase(str: string): string {
  return str.replace(/([A-Z])/g, '_$1').toLowerCase();
}

/**
 * Creates a sub-query builder for handling Brackets clauses
 */
export function createBracketsQb() {
  const conditions: Array<{ type: 'where' | 'or'; sql: string; params: Record<string, unknown> }> = [];

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
 * Creates a mock QueryBuilder that executes against PGlite
 */
export function createMockQueryBuilder(pglite: PGlite, _initialEntity?: typeof ChronoTaskEntity) {
  let operation: 'select' | 'update' | 'delete' = 'select';
  let alias = 'entity';
  const whereClauses: Array<{ sql: string; params: Record<string, unknown> }> = [];
  let setValues: Record<string, unknown> = {};
  let orderByClauses: Array<{ field: string; direction: 'ASC' | 'DESC' }> = [];
  let hasReturning = false;
  let lockMode: string | undefined;

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

/**
 * Creates a mock DataSource that wraps PGlite to provide the interface
 * expected by ChronoPostgresDatastore with QueryBuilder support
 */
export function createMockDataSource(pglite: PGlite) {
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

export type MockDataSource = ReturnType<typeof createMockDataSource>;
