/**
 * Mock Entity Manager
 *
 * Simulates TypeORM's EntityManager interface for testing.
 * Provides methods for creating, saving, and finding entities.
 */

import type { PGlite } from '@electric-sql/pglite';
import { faker } from '@faker-js/faker';

import type { ChronoTaskEntity } from '../../src/chrono-task.entity';
import { TEST_TABLE_NAME } from '../database-setup';
import { mapRowToEntity } from './entity-mapper';
import { createMockQueryBuilder, type MockQueryBuilder } from './mock-query-builder';

/**
 * Options for the findOne method.
 */
type FindOneOptions = {
  where: Partial<ChronoTaskEntity>;
};

/**
 * Creates a mock EntityManager that executes operations against PGlite.
 */
export function createMockEntityManager(pglite: PGlite) {
  return {
    /**
     * Executes a raw SQL query.
     */
    async query(sql: string, params?: unknown[]): Promise<unknown[]> {
      const result = await pglite.query(sql, params);
      return result.rows;
    },

    /**
     * Creates an entity instance (doesn't persist it).
     * In TypeORM, this initializes default values and sets up the entity.
     * For testing, we just return the data as-is.
     */
    create(_entityClass: typeof ChronoTaskEntity, data: Partial<ChronoTaskEntity>): Partial<ChronoTaskEntity> {
      return data;
    },

    /**
     * Saves an entity to the database.
     * Generates an ID if not provided and sets timestamps.
     */
    async save(_entityClass: typeof ChronoTaskEntity, data: Partial<ChronoTaskEntity>): Promise<ChronoTaskEntity> {
      const id = faker.string.uuid();
      const now = new Date();

      const result = await pglite.query(
        `INSERT INTO ${TEST_TABLE_NAME}
         (id, kind, status, data, priority, idempotency_key,
          original_schedule_date, scheduled_at, retry_count,
          created_at, updated_at)
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

    /**
     * Finds a single entity matching the given criteria.
     * Currently supports filtering by `id` and `idempotencyKey`.
     */
    async findOne(_entityClass: typeof ChronoTaskEntity, options: FindOneOptions): Promise<ChronoTaskEntity | null> {
      const { where } = options;

      // Build the query dynamically based on provided filters
      const conditions: string[] = ['1=1']; // Start with always-true for easy AND appending
      const params: unknown[] = [];
      let paramIndex = 1;

      if (where.id) {
        conditions.push(`id = $${paramIndex}`);
        params.push(where.id);
        paramIndex++;
      }

      if (where.idempotencyKey) {
        conditions.push(`idempotency_key = $${paramIndex}`);
        params.push(where.idempotencyKey);
        paramIndex++;
      }

      const sql = `
        SELECT * FROM ${TEST_TABLE_NAME}
        WHERE ${conditions.join(' AND ')}
        LIMIT 1
      `;

      const result = await pglite.query(sql, params);

      if (result.rows.length === 0) {
        return null;
      }

      return mapRowToEntity(result.rows[0] as Record<string, unknown>);
    },

    /**
     * Creates a QueryBuilder for complex queries.
     */
    createQueryBuilder(entity?: typeof ChronoTaskEntity, alias?: string): MockQueryBuilder {
      const qb = createMockQueryBuilder(pglite);

      if (alias && entity) {
        qb.from(entity, alias);
      }

      return qb;
    },
  };
}

export type MockEntityManager = ReturnType<typeof createMockEntityManager>;
