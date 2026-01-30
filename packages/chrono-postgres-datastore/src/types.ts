/**
 * Represents a row from the chrono_tasks table.
 * Uses snake_case to match database column names.
 */
export type ChronoTaskRow = {
  id: string;
  kind: string;
  status: string;
  data: Record<string, unknown>;
  priority: number | null;
  idempotency_key: string | null;
  original_schedule_date: Date;
  scheduled_at: Date;
  claimed_at: Date | null;
  completed_at: Date | null;
  last_executed_at: Date | null;
  retry_count: number;
  created_at: Date;
  updated_at: Date;
};
