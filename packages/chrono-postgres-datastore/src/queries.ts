/**
 * SQL query constants for chrono-postgres-datastore.
 * All queries use prepared statement placeholders ($1, $2, etc.).
 */

export const SCHEDULE_QUERY = `
  INSERT INTO chrono_tasks (
    kind, status, data, priority, idempotency_key,
    original_schedule_date, scheduled_at, retry_count
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  RETURNING *
`;

export const FIND_BY_IDEMPOTENCY_KEY_QUERY = `
  SELECT * FROM chrono_tasks WHERE idempotency_key = $1
`;

export const CLAIM_QUERY = `
  UPDATE chrono_tasks
  SET status = $1, claimed_at = $2, updated_at = $2
  WHERE id = (
    SELECT id FROM chrono_tasks
    WHERE kind = $3
      AND scheduled_at <= $2
      AND (status = $4 OR (status = $1 AND claimed_at <= $5))
    ORDER BY priority DESC, scheduled_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *
`;

export const RETRY_QUERY = `
  UPDATE chrono_tasks
  SET status = $1, scheduled_at = $2, claimed_at = NULL, updated_at = $3, retry_count = retry_count + 1
  WHERE id = $4
  RETURNING *
`;

export const COMPLETE_QUERY = `
  UPDATE chrono_tasks
  SET status = $1, completed_at = $2, last_executed_at = $3, updated_at = $4
  WHERE id = $5
  RETURNING *
`;

export const FAIL_QUERY = `
  UPDATE chrono_tasks
  SET status = $1, last_executed_at = $2, updated_at = $3
  WHERE id = $4
  RETURNING *
`;

// Delete by ID (without force - only PENDING tasks)
export const DELETE_BY_ID_QUERY = `
  DELETE FROM chrono_tasks
  WHERE id = $1 AND status = $2
  RETURNING *
`;

// Delete by ID (with force - any status)
export const DELETE_BY_ID_FORCE_QUERY = `
  DELETE FROM chrono_tasks
  WHERE id = $1
  RETURNING *
`;

// Delete by kind + idempotency key (without force - only PENDING tasks)
export const DELETE_BY_KEY_QUERY = `
  DELETE FROM chrono_tasks
  WHERE kind = $1 AND idempotency_key = $2 AND status = $3
  RETURNING *
`;

// Delete by kind + idempotency key (with force - any status)
export const DELETE_BY_KEY_FORCE_QUERY = `
  DELETE FROM chrono_tasks
  WHERE kind = $1 AND idempotency_key = $2
  RETURNING *
`;

// Cleanup: delete old completed tasks with limit
export const CLEANUP_QUERY = `
  DELETE FROM chrono_tasks
  WHERE id IN (
    SELECT id FROM chrono_tasks
    WHERE status = $1 AND completed_at < $2
    LIMIT $3
  )
`;
