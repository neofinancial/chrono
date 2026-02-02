import type { PoolClient } from 'pg';

/**
 * SQL to create the chrono_tasks table and indexes.
 * Can be used directly in a migration or executed via migrateUp().
 */
export const MIGRATION_UP_SQL = `
CREATE TABLE IF NOT EXISTS chrono_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind varchar(255) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'PENDING',
  data jsonb NOT NULL,
  priority integer DEFAULT 0,
  idempotency_key varchar(255),
  original_schedule_date timestamptz NOT NULL,
  scheduled_at timestamptz NOT NULL,
  claimed_at timestamptz,
  completed_at timestamptz,
  last_executed_at timestamptz,
  retry_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chrono_tasks_claim
  ON chrono_tasks (kind, status, scheduled_at, priority, claimed_at);

CREATE INDEX IF NOT EXISTS idx_chrono_tasks_cleanup
  ON chrono_tasks (status, completed_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chrono_tasks_idempotency
  ON chrono_tasks (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
`;

/**
 * SQL to drop the chrono_tasks table and indexes.
 * Can be used directly in a migration or executed via migrateDown().
 */
export const MIGRATION_DOWN_SQL = `
DROP INDEX IF EXISTS idx_chrono_tasks_idempotency;
DROP INDEX IF EXISTS idx_chrono_tasks_cleanup;
DROP INDEX IF EXISTS idx_chrono_tasks_claim;
DROP TABLE IF EXISTS chrono_tasks;
`;

/**
 * Executes the up migration to create the chrono_tasks table.
 * @param client - A pg PoolClient (can be within a transaction)
 */
export async function migrateUp(client: PoolClient): Promise<void> {
  await client.query(MIGRATION_UP_SQL);
}

/**
 * Executes the down migration to drop the chrono_tasks table.
 * @param client - A pg PoolClient (can be within a transaction)
 */
export async function migrateDown(client: PoolClient): Promise<void> {
  await client.query(MIGRATION_DOWN_SQL);
}
