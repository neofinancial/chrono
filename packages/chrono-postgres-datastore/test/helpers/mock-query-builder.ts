/**
 * Mock Query Builder
 *
 * Simulates TypeORM's QueryBuilder interface but executes queries against PGlite.
 * This allows testing the datastore without needing a full TypeORM setup.
 *
 * The QueryBuilder uses a fluent interface where each method returns `this`,
 * allowing method chaining like:
 * ```ts
 * qb.update(Entity).set({ status: 'DONE' }).where('id = :id', { id: '123' }).execute()
 * ```
 */

import type { PGlite } from '@electric-sql/pglite';

import type { ChronoTaskEntity } from '../../src/chrono-task.entity';
import { TEST_TABLE_NAME } from '../database-setup';
import { mapRowToEntity } from './entity-mapper';
import { removeAliasPrefix, toSnakeCase } from './sql-utils';
import { createBracketsQueryBuilder, WhereClauseCollection } from './where-clause-builder';

/**
 * The type of SQL operation being built.
 */
type OperationType = 'select' | 'update' | 'delete';

/**
 * Defines the sort order for a column.
 */
type OrderByClause = {
  field: string;
  direction: 'ASC' | 'DESC';
};

/**
 * The result of executing a query.
 */
export type QueryResult = {
  raw: ChronoTaskEntity[];
  affected: number;
};

/**
 * Creates a mock QueryBuilder that translates TypeORM method calls into
 * raw SQL executed against PGlite.
 */
export function createMockQueryBuilder(pglite: PGlite) {
  // Query state
  let operation: OperationType = 'select';
  let tableAlias = 'entity';
  let setValues: Record<string, unknown> = {};
  let orderByClauses: OrderByClause[] = [];
  let includeReturning = false;
  let lockMode: string | undefined;
  let limitValue: number | undefined;
  let selectColumns: string[] = ['*'];
  let whereInIdsValues: string[] = [];

  // WHERE clause builder
  const whereBuilder = new WhereClauseCollection(tableAlias);

  // The query builder object with all chainable methods
  const queryBuilder = {
    // ─────────────────────────────────────────────────────────────────
    // Operation Type Methods
    // ─────────────────────────────────────────────────────────────────

    select(columns?: string | string[]) {
      operation = 'select';
      if (columns) {
        selectColumns = Array.isArray(columns) ? columns : [columns];
      }
      return queryBuilder;
    },

    update(_entity: typeof ChronoTaskEntity) {
      operation = 'update';
      return queryBuilder;
    },

    delete() {
      operation = 'delete';
      return queryBuilder;
    },

    from(_entity: typeof ChronoTaskEntity, alias?: string) {
      if (alias) {
        tableAlias = alias;
        whereBuilder.setAlias(alias);
      }
      return queryBuilder;
    },

    // ─────────────────────────────────────────────────────────────────
    // WHERE Clause Methods
    // ─────────────────────────────────────────────────────────────────

    /**
     * Adds a WHERE condition. Handles three formats:
     * 1. String condition: 'status = :status'
     * 2. Callback function: (qb) => qb.where(...)
     * 3. Brackets object: new Brackets((qb) => ...)
     */
    where(condition: string | { getQuery: () => string } | unknown, params?: Record<string, unknown>) {
      if (typeof condition === 'function') {
        // Direct callback function
        const bracketsQb = createBracketsQueryBuilder(tableAlias);
        (condition as (qb: ReturnType<typeof createBracketsQueryBuilder>) => void)(bracketsQb);
        whereBuilder.addBracketsCondition(bracketsQb);
      } else if (isObjectWithProperty(condition, 'getQuery')) {
        // Brackets object with getQuery method
        const bracketsObj = condition as { getQuery: () => string };
        whereBuilder.addCondition(bracketsObj.getQuery(), params || {});
      } else if (typeof condition === 'string') {
        // Simple string condition
        whereBuilder.addCondition(condition, params || {});
      }

      return queryBuilder;
    },

    /**
     * Adds an AND WHERE condition.
     * Also handles TypeORM Brackets objects (which use 'whereFactory' property).
     */
    andWhere(condition: string | { getQuery: () => string } | unknown, params?: Record<string, unknown>) {
      // TypeORM Brackets objects store their callback in 'whereFactory'
      if (isObjectWithProperty(condition, 'whereFactory')) {
        const bracketsQb = createBracketsQueryBuilder(tableAlias);
        const brackets = condition as {
          whereFactory: (qb: ReturnType<typeof createBracketsQueryBuilder>) => void;
        };
        brackets.whereFactory(bracketsQb);
        whereBuilder.addBracketsCondition(bracketsQb);
        return queryBuilder;
      }

      // Otherwise, treat it as a regular where condition
      return queryBuilder.where(condition, params);
    },

    /**
     * Adds an OR condition to the previous WHERE clause.
     */
    orWhere(condition: string, params?: Record<string, unknown>) {
      whereBuilder.addOrCondition(condition, params || {});
      return queryBuilder;
    },

    /**
     * Adds a WHERE IN condition for IDs.
     */
    whereInIds(ids: string[]) {
      whereInIdsValues = ids;
      return queryBuilder;
    },

    // ─────────────────────────────────────────────────────────────────
    // UPDATE Methods
    // ─────────────────────────────────────────────────────────────────

    /**
     * Sets the values to update.
     * Values can be primitives or functions that return raw SQL.
     */
    set(values: Record<string, unknown>) {
      setValues = values;
      return queryBuilder;
    },

    // ─────────────────────────────────────────────────────────────────
    // SELECT Methods
    // ─────────────────────────────────────────────────────────────────

    /**
     * Sets the primary ORDER BY column (replaces any existing order).
     */
    orderBy(field: string, direction: 'ASC' | 'DESC' = 'ASC') {
      const cleanField = removeAliasPrefix(field, tableAlias);
      orderByClauses = [{ field: cleanField, direction }];
      return queryBuilder;
    },

    /**
     * Adds an additional ORDER BY column.
     */
    addOrderBy(field: string, direction: 'ASC' | 'DESC' = 'ASC') {
      const cleanField = removeAliasPrefix(field, tableAlias);
      orderByClauses.push({ field: cleanField, direction });
      return queryBuilder;
    },

    /**
     * Sets a LIMIT for the query.
     */
    limit(limit: number) {
      limitValue = limit;
      return queryBuilder;
    },

    /**
     * Enables RETURNING * for INSERT/UPDATE/DELETE queries.
     */
    returning(_columns: string) {
      includeReturning = true;
      return queryBuilder;
    },

    /**
     * Sets the lock mode for SELECT queries.
     */
    setLock(mode: string, _version?: unknown, _tables?: string[]) {
      lockMode = mode;
      return queryBuilder;
    },

    // ─────────────────────────────────────────────────────────────────
    // Execution Methods
    // ─────────────────────────────────────────────────────────────────

    /**
     * Executes a SELECT query and returns at most one result.
     */
    async getOne(): Promise<ChronoTaskEntity | null> {
      const sql = buildSelectSql(1);
      const { values } = whereBuilder.build();

      const result = await pglite.query(sql, values);

      if (result.rows.length === 0) {
        return null;
      }

      return mapRowToEntity(result.rows[0] as Record<string, unknown>);
    },

    /**
     * Executes a SELECT query and returns all matching results (respects limit).
     */
    async getMany(): Promise<ChronoTaskEntity[]> {
      const sql = buildSelectSql(limitValue);
      const { values } = whereBuilder.build();

      const result = await pglite.query(sql, values);

      return (result.rows as Record<string, unknown>[]).map(mapRowToEntity);
    },

    /**
     * Executes the query (UPDATE or DELETE) and returns affected rows.
     */
    async execute(): Promise<QueryResult> {
      if (operation === 'delete') {
        return executeDelete();
      }

      if (operation === 'update') {
        return executeUpdate();
      }

      return { raw: [], affected: 0 };
    },
  };

  // ─────────────────────────────────────────────────────────────────
  // Helper Functions
  // ─────────────────────────────────────────────────────────────────

  /**
   * Builds a SELECT SQL statement with all clauses.
   */
  function buildSelectSql(limit?: number): string {
    const { sql: whereClause } = whereBuilder.build();

    // Build column list from selectColumns
    const columns = selectColumns
      .map((col) => {
        if (col === '*') return '*';
        // Remove alias prefix (e.g., 'task.id' -> 'id')
        const cleanCol = removeAliasPrefix(col, tableAlias);
        return toSnakeCase(cleanCol);
      })
      .join(', ');

    let sql = `SELECT ${columns} FROM ${TEST_TABLE_NAME}`;

    if (whereClause) {
      sql += ` WHERE ${whereClause}`;
    }

    if (orderByClauses.length > 0) {
      const orderByParts = orderByClauses.map((clause) => {
        const snakeField = toSnakeCase(clause.field);
        return `${snakeField} ${clause.direction}`;
      });
      sql += ` ORDER BY ${orderByParts.join(', ')}`;
    }

    if (limit !== undefined) {
      sql += ` LIMIT ${limit}`;
    }

    if (lockMode) {
      sql += ' FOR UPDATE SKIP LOCKED';
    }

    return sql;
  }

  /**
   * Executes a DELETE statement.
   */
  async function executeDelete(): Promise<QueryResult> {
    const { sql: whereClause, values: whereValues } = whereBuilder.build();

    let sql = `DELETE FROM ${TEST_TABLE_NAME}`;
    let values = whereValues;

    if (whereInIdsValues.length > 0) {
      // Handle whereInIds - create parameterized IN clause
      const placeholders = whereInIdsValues.map((_, i) => `$${i + 1}`).join(', ');
      sql += ` WHERE id IN (${placeholders})`;
      values = whereInIdsValues;
    } else if (whereClause) {
      sql += ` WHERE ${whereClause}`;
    }

    if (includeReturning) {
      sql += ' RETURNING *';
    }

    const result = await pglite.query(sql, values);
    const entities = (result.rows as Record<string, unknown>[]).map(mapRowToEntity);

    return { raw: entities, affected: result.rows.length };
  }

  /**
   * Executes an UPDATE statement.
   */
  async function executeUpdate(): Promise<QueryResult> {
    const { sql: whereClause, values: whereValues } = whereBuilder.build();

    // Build SET clause
    const { setClauses, setParamValues } = buildSetClause(whereValues.length);

    let sql = `UPDATE ${TEST_TABLE_NAME} SET ${setClauses.join(', ')}`;

    if (whereClause) {
      sql += ` WHERE ${whereClause}`;
    }

    if (includeReturning) {
      sql += ' RETURNING *';
    }

    const allValues = [...whereValues, ...setParamValues];
    const result = await pglite.query(sql, allValues);
    const entities = (result.rows as Record<string, unknown>[]).map(mapRowToEntity);

    return { raw: entities, affected: result.rows.length };
  }

  /**
   * Builds the SET clause for an UPDATE statement.
   * Handles both regular values and raw SQL expressions (functions).
   */
  function buildSetClause(startParamIndex: number): {
    setClauses: string[];
    setParamValues: unknown[];
  } {
    const setClauses: string[] = [];
    const setParamValues: unknown[] = [];
    let paramIndex = startParamIndex + 1;

    for (const [key, value] of Object.entries(setValues)) {
      const snakeKey = toSnakeCase(key);

      if (typeof value === 'function') {
        // Raw SQL expression, e.g., () => 'NULL' or () => 'retry_count + 1'
        const rawSql = value();
        setClauses.push(`${snakeKey} = ${rawSql}`);
      } else {
        // Regular parameter value
        setClauses.push(`${snakeKey} = $${paramIndex}`);
        setParamValues.push(value);
        paramIndex++;
      }
    }

    return { setClauses, setParamValues };
  }

  return queryBuilder;
}

/**
 * Type guard to check if a value is an object with a specific property.
 */
function isObjectWithProperty(value: unknown, property: string): boolean {
  return typeof value === 'object' && value !== null && property in value;
}

export type MockQueryBuilder = ReturnType<typeof createMockQueryBuilder>;
