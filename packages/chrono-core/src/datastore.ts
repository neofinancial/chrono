export type TaskStatus = 'pending' | 'claimed' | 'completed' | 'failed';

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
};

export type ScheduleInput<TaskKind, TaskData, DatastoreOptions> = {
  when: Date;
  kind: TaskKind;
  data: TaskData;
  priority?: 0;
  idempotencyKey?: string;
  datastoreOptions?: DatastoreOptions;
};

export interface Datastore<DatastoreOptions> {
  schedule<TaskKind, TaskData>(
    input: ScheduleInput<TaskKind, TaskData, DatastoreOptions>,
  ): Promise<Task<TaskKind, TaskData>>;

  claim<TaskKind, TaskData>(): Promise<Task<TaskKind, TaskData>>;

  complete(taskId: string): Promise<void>;

  fail(taskId: string, error: Error): Promise<void>;
}
