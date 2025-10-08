import type { TaskMappingBase } from './chrono';

export const TaskStatus = {
  PENDING: 'PENDING',
  CLAIMED: 'CLAIMED',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const;
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

export type Task<TaskKind, TaskData> = {
  /** A unique identifier for the task */
  id: string;
  /** A human-readable name or type for the task */
  kind: TaskKind;
  /** The current status of the task */
  status: TaskStatus;
  /** The payload or data associated with the task */
  data: TaskData;
  /** The priority level of the task (lower numbers can indicate higher priority) */
  priority?: number;
  /** A key used for idempotency to prevent duplicate processing */
  idempotencyKey?: string;
  /** The original scheduled date when the task was first intended to run */
  originalScheduleDate: Date;
  /** The current scheduled execution date, which may change if rescheduled */
  scheduledAt: Date;
  /** The date the task is mark 'claimed */
  claimedAt?: Date;
  /** The date the task is mark 'completed' */
  completedAt?: Date;
  /** The date when the task was last executed (if any) */
  lastExecutedAt?: Date;
  /** A counter to track the number of times the task has been retried */
  retryCount: number;
};

export type ScheduleInput<TaskKind, TaskData, DatastoreOptions> = {
  /** The date and time when the task is scheduled to run */
  when: Date;
  /** The type of task */
  kind: TaskKind;
  /** The payload or data associated with the task */
  data: TaskData;
  /** The priority level of the task (lower numbers can indicate higher priority) */
  priority?: number;
  /** A key used for idempotency to prevent duplicate processing */
  idempotencyKey?: string;
  /** Additional options for the datastore to use when scheduling the task in the datastore. Can include things like a session for database transactions. Unique per datastore implementation.*/
  datastoreOptions?: DatastoreOptions;
};

export type ClaimTaskInput<TaskKind> = {
  kind: TaskKind;
  claimStaleTimeoutMs: number;
};

export type DeleteByIdempotencyKeyInput<TaskKind> = {
  kind: TaskKind;
  idempotencyKey: string;
};

export type DeleteOptions = {
  force?: boolean;
};

export type DeleteInput<TaskKind> = DeleteByIdempotencyKeyInput<TaskKind> | string;

export interface Datastore<TaskMapping extends TaskMappingBase, DatastoreOptions> {
  schedule<TaskKind extends keyof TaskMapping>(
    input: ScheduleInput<TaskKind, TaskMapping[TaskKind], DatastoreOptions>,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]>>;
  delete<TaskKind extends keyof TaskMapping>(
    taskId: string,
    options?: DeleteOptions,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]> | undefined>;
  delete<TaskKind extends keyof TaskMapping>(
    key: DeleteByIdempotencyKeyInput<TaskKind>,
    options?: DeleteOptions,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]> | undefined>;
  claim<TaskKind extends Extract<keyof TaskMapping, string>>(
    input: ClaimTaskInput<TaskKind>,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]> | undefined>;
  retry<TaskKind extends keyof TaskMapping>(
    taskId: string,
    retryAt: Date,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]>>;
  complete<TaskKind extends keyof TaskMapping>(taskId: string): Promise<Task<TaskKind, TaskMapping[TaskKind]>>;
  fail<TaskKind extends keyof TaskMapping>(taskId: string): Promise<Task<TaskKind, TaskMapping[TaskKind]>>;
}
