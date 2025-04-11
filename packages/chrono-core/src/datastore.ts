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
  /** Identifier used to group tasks together so that they are processed sequentially. FIFO
   * Should be used sparingly and only when necessary, as it can lead to performance issues.
   */
  groupId?: string;
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
  when: Date;
  kind: TaskKind;
  data: TaskData;
  priority?: number;
  idempotencyKey?: string;
  datastoreOptions?: DatastoreOptions;
};

export type ClaimTaskInput<TaskKind> = {
  kind: TaskKind;
};

export interface Datastore<TaskMapping extends TaskMappingBase, DatastoreOptions> {
  schedule<TaskKind extends keyof TaskMapping>(
    input: ScheduleInput<TaskKind, TaskMapping[TaskKind], DatastoreOptions>,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]>>;
  claim<TaskKind extends Extract<keyof TaskMapping, string>>(
    input: ClaimTaskInput<TaskKind>,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]> | undefined>;
  unclaim<TaskKind extends keyof TaskMapping>(
    taskId: string,
    nextScheduledAt: Date,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]>>;
  complete<TaskKind extends keyof TaskMapping>(taskId: string): Promise<Task<TaskKind, TaskMapping[TaskKind]>>;
  fail<TaskKind extends keyof TaskMapping>(taskId: string): Promise<Task<TaskKind, TaskMapping[TaskKind]>>;
}
