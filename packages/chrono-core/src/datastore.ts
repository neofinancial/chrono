export interface Task<TaskData> {
  id: string;
  type: string;
  data: TaskData;
  status: "PENDING" | "CLAIMED" | "COMPLETE" | "FAILED";
  priority: number;
  idempotencyKey?: string;
  originallyScheduledAt?: Date;
  scheduledAt: Date;
  claimedAt?: Date;
  lastExecutedAt?: Date;
  retryCount: number;
  errorMessage?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ScheduleInput<TaskData> {
  type: string;
  data: object;
  priority?: number;
  idempotencyKey?: string;
  scheduledAt: Date;
}

export interface ClaimInput {
  type: string;
}

export interface UnClaimInput {
  taskId: string;
}

export interface CompleteInput {
  taskId: string;
}

export interface DataStore<DataStoreOptions, TaskData extends object = object> {
  schedule(
    input: ScheduleInput<TaskData>,
    options: DataStoreOptions
  ): Promise<Task<TaskData>>;
  unschedule(
    taskId: string,
    options: DataStoreOptions
  ): Promise<Task<TaskData> | undefined>;
  claim(
    input: ClaimInput,
    options: DataStoreOptions
  ): Promise<Task<TaskData> | undefined>;
  unclaim(
    input: UnClaimInput,
    options: DataStoreOptions
  ): Promise<Task<TaskData> | undefined>;
  complete(
    input: CompleteInput,
    options: DataStoreOptions
  ): Promise<Task<TaskData>>;
}
