export type TaskStatus = 'pending' | 'claimed' | 'completed' | 'failed';

export type Task<TaskKind, TaskData> = {
  id: string;
  kind: TaskKind;
  status: TaskStatus;
  data: TaskData;
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
}
