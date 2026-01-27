/**
 * Mock DataSource
 *
 * Simulates TypeORM's DataSource interface for testing ChronoPostgresDatastore.
 * This is the main entry point for test mocking - it provides everything needed
 * to test the datastore without a real PostgreSQL connection.
 *
 * Usage:
 * ```ts
 * const pglite = new PGlite();
 * const mockDataSource = createMockDataSource(pglite);
 * await dataStore.initialize(mockDataSource);
 * ```
 */

import type { PGlite } from '@electric-sql/pglite';

import type { ChronoTaskEntity } from '../../src/chrono-task.entity';
import { createMockEntityManager, type MockEntityManager } from './mock-entity-manager';
import { createMockQueryBuilder, type MockQueryBuilder } from './mock-query-builder';

/**
 * Creates a mock DataSource that wraps PGlite.
 *
 * The DataSource provides:
 * - `manager`: An EntityManager for CRUD operations
 * - `createQueryBuilder`: For complex queries
 * - `transaction`: For wrapping operations in a transaction
 */
export function createMockDataSource(pglite: PGlite) {
  const manager = createMockEntityManager(pglite);

  return {
    /**
     * The EntityManager for this DataSource.
     */
    manager,

    /**
     * Whether the DataSource has been initialized.
     */
    isInitialized: true,

    /**
     * Closes the DataSource connection.
     * No-op for PGlite since we manage its lifecycle separately.
     */
    async destroy(): Promise<void> {
      // PGlite lifecycle is managed by the test setup
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

    /**
     * Executes a callback within a transaction.
     *
     * Note: PGlite doesn't support true transactions in the same way as
     * a real PostgreSQL connection. For testing purposes, we simply
     * execute the work directly. This is acceptable because:
     * 1. Tests run sequentially within a single test file
     * 2. We clean up the database between tests
     * 3. We're testing logic, not transaction isolation
     */
    async transaction<T>(work: (transactionManager: MockEntityManager) => Promise<T>): Promise<T> {
      return work(manager);
    },
  };
}

export type MockDataSource = ReturnType<typeof createMockDataSource>;
