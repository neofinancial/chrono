/**
 * Entity Mapper
 *
 * Converts raw PostgreSQL rows (with snake_case columns) to
 * ChronoTaskEntity objects (with camelCase properties).
 */

import type { ChronoTaskEntity } from '../../src/chrono-task.entity';

/**
 * A raw database row with snake_case column names.
 */
type DatabaseRow = Record<string, unknown>;

/**
 * Safely parses a value as a Date, or returns null if the value is falsy.
 */
function parseDate(value: unknown): Date | null {
  if (!value) return null;
  return new Date(value as string);
}

/**
 * Parses the JSON data field, handling both string and object formats.
 * PGlite may return JSONB as either a string or an already-parsed object.
 */
function parseJsonData(data: unknown): Record<string, unknown> {
  if (typeof data === 'string') {
    return JSON.parse(data);
  }
  return data as Record<string, unknown>;
}

/**
 * Maps a raw PostgreSQL row to a ChronoTaskEntity object.
 *
 * This handles the conversion from:
 * - snake_case column names to camelCase property names
 * - String dates to Date objects
 * - JSONB data that may be a string or object
 *
 * @example
 * const row = { id: '123', scheduled_at: '2024-01-01', ... };
 * const entity = mapRowToEntity(row);
 * // entity.scheduledAt is now a Date object
 */
export function mapRowToEntity(row: DatabaseRow): ChronoTaskEntity {
  return {
    id: row.id as string,
    kind: row.kind as string,
    status: row.status as string,
    data: parseJsonData(row.data),
    priority: row.priority as number | null,
    idempotencyKey: row.idempotency_key as string | null,
    originalScheduleDate: new Date(row.original_schedule_date as string),
    scheduledAt: new Date(row.scheduled_at as string),
    claimedAt: parseDate(row.claimed_at),
    completedAt: parseDate(row.completed_at),
    lastExecutedAt: parseDate(row.last_executed_at),
    retryCount: row.retry_count as number,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  } as ChronoTaskEntity;
}
