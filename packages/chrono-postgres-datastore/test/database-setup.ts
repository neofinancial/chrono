/* eslint-disable no-console */
import { PGlite } from '@electric-sql/pglite';
import { DataSource } from 'typeorm';

import { ChronoTaskEntity } from '../src/chrono-task.entity';

const formatMemoryUsage = (data: number) => `${Math.round((data / 1024 / 1024) * 100) / 100} MB`;

export const TEST_TABLE_NAME = 'chrono_tasks';

// Global PGlite instance for tests
let pglite: PGlite | undefined;
let dataSource: DataSource | undefined;

/**
 * Creates a TypeORM-compatible DataSource using PGlite
 */
export async function createPGliteDataSource(): Promise<DataSource> {
  if (!pglite) {
    throw new Error('PGlite not initialized. Call setup() first.');
  }

  // Create a new DataSource that uses PGlite
  // We use the 'postgres' type but provide a custom driver
  const ds = new DataSource({
    type: 'postgres',
    driver: pglite,
    entities: [ChronoTaskEntity],
    synchronize: true,
    logging: false,
  } as any);

  await ds.initialize();
  return ds;
}

/**
 * Gets the shared PGlite instance
 */
export function getPGlite(): PGlite {
  if (!pglite) {
    throw new Error('PGlite not initialized. Call setup() first.');
  }
  return pglite;
}

/**
 * @remarks
 * https://vitest.dev/config/#globalsetup
 */
export async function setup(): Promise<void> {
  const { heapTotal: heapTotalBefore, heapUsed: heapUsedBefore } = process.memoryUsage();

  // Create in-memory PGlite instance
  pglite = new PGlite();

  console.table({
    database: 'PGlite (in-memory)',
    heapTotal: formatMemoryUsage(heapTotalBefore),
    heapUsed: formatMemoryUsage(heapUsedBefore),
  });

  // Create the table schema directly using PGlite
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

  await pglite.exec(`
    CREATE INDEX IF NOT EXISTS idx_chrono_tasks_claim
    ON ${TEST_TABLE_NAME} (kind, status, scheduled_at ASC, priority DESC, claimed_at)
  `);

  console.log('PGlite initialized with chrono_tasks table');
}

/**
 * @remarks
 * https://vitest.dev/config/#globalsetup
 */
export async function teardown(): Promise<void> {
  const { heapTotal: heapTotalAfter, heapUsed: heapUsedAfter } = process.memoryUsage();

  if (dataSource?.isInitialized) {
    await dataSource.destroy();
  }

  if (pglite) {
    await pglite.close();
  }

  console.log({
    heapTotal: formatMemoryUsage(heapTotalAfter),
    heapUsed: formatMemoryUsage(heapUsedAfter),
  });
}
