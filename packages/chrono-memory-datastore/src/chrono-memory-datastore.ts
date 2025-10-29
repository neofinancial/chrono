import {
  type ClaimTaskInput,
  type Datastore,
  type DeleteInput,
  type DeleteOptions,
  type ScheduleInput,
  type Task,
  type TaskMappingBase,
  TaskStatus,
} from '@neofinancial/chrono';

const DEFAULT_MAX_DLQ_RETRIES = 3;

type DlqEntry<TaskKind, TaskData> = {
  task: Task<TaskKind, TaskData>;
  error?: Error;
  dlqRetryCount: number;
  failedAt: Date;
  lastRedrivenAt?: Date;
};

export type ChronoMemoryDatastoreConfig = {
  /**
   * Maximum number of times a task can be redriven from DLQ before it's permanently failed
   *
   * @default 3
   * @type {number}
   */
  maxDlqRetries?: number;
};

export class ChronoMemoryDatastore<TaskMapping extends TaskMappingBase, MemoryDatastoreOptions>
  implements Datastore<TaskMapping, MemoryDatastoreOptions>
{
  private store: Map<string, Task<keyof TaskMapping, TaskMapping[keyof TaskMapping]>>;
  private dlqStore: Map<string, DlqEntry<keyof TaskMapping, TaskMapping[keyof TaskMapping]>>;
  private nextId: number;
  private config: ChronoMemoryDatastoreConfig;

  constructor(config?: ChronoMemoryDatastoreConfig) {
    this.store = new Map();
    this.dlqStore = new Map();
    this.nextId = 0;
    this.config = {
      maxDlqRetries: config?.maxDlqRetries ?? DEFAULT_MAX_DLQ_RETRIES,
    };
  }

  /**
   * Schedules a task and returns it.
   *
   * @param input The input to schedule the task.
   * @returns The scheduled task.
   */
  async schedule<TaskKind extends keyof TaskMapping>(
    input: ScheduleInput<TaskKind, TaskMapping[TaskKind], MemoryDatastoreOptions>,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]>> {
    if (input.idempotencyKey) {
      const existingTask = Array.from(this.store.values())
        .filter((t): t is Task<TaskKind, TaskMapping[TaskKind]> => t.kind === input.kind)
        .find((t) => t?.idempotencyKey === input.idempotencyKey);

      if (existingTask) {
        return existingTask;
      }
    }

    const id = (this.nextId++).toString();

    const task: Task<TaskKind, TaskMapping[TaskKind]> = {
      id,
      kind: input.kind,
      status: TaskStatus.PENDING,
      data: input.data,
      priority: input.priority ?? 0,
      idempotencyKey: input.idempotencyKey,
      originalScheduleDate: input.when,
      scheduledAt: input.when,
      retryCount: 0,
    };

    this.store.set(id, task);

    return task;
  }

  /**
   * Deletes a task from the datastore and returns it.
   *
   * @param key Information required to locate the task to delete.
   * @param force when true delete tasks of any status and noop on missing tasks.
   * @returns The deleted task.
   */
  async delete<TaskKind extends keyof TaskMapping>(
    key: DeleteInput<TaskKind>,
    options?: DeleteOptions,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]> | undefined> {
    const filter =
      typeof key === 'string'
        ? (t: Task<keyof TaskMapping, TaskMapping[keyof TaskMapping]>): t is Task<TaskKind, TaskMapping[TaskKind]> =>
            t.id === key
        : (t: Task<keyof TaskMapping, TaskMapping[keyof TaskMapping]>): t is Task<TaskKind, TaskMapping[TaskKind]> =>
            t.kind === key.kind && t.idempotencyKey === key.idempotencyKey;

    const taskToRemove = Array.from(this.store.values()).find((t) => filter(t));

    const taskIsPending = taskToRemove?.status === TaskStatus.PENDING;

    if (taskToRemove && (taskIsPending || options?.force)) {
      this.store.delete(taskToRemove.id);

      return taskToRemove;
    }

    if (options?.force) {
      return;
    }

    const description =
      typeof key === 'string'
        ? `with id ${key}`
        : `with kind ${String(key.kind)} and idempotencyKey ${key.idempotencyKey}`;

    throw new Error(`Task ${description} can not be deleted as it may not exist or it's not in PENDING status.`);
  }

  /**
   * Claims a task and returns it.
   *
   * @param input The input to claim the task.
   * @returns The claimed task or undefined if no task is available.
   */
  async claim<TaskKind extends keyof TaskMapping>(
    input: ClaimTaskInput<TaskKind>,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]> | undefined> {
    const now = new Date();

    const claimedTask = Array.from(this.store.values()).find((t) => {
      if (t.kind === input.kind && t.status === TaskStatus.PENDING) {
        return t;
      }

      if (
        t.kind === input.kind &&
        t.status === TaskStatus.CLAIMED &&
        t.claimedAt &&
        t.claimedAt <= new Date(now.getTime() - input.claimStaleTimeoutMs)
      ) {
        return t;
      }

      return undefined;
    });

    if (claimedTask) {
      claimedTask.status = TaskStatus.CLAIMED;
      claimedTask.claimedAt = now;

      return claimedTask as Task<TaskKind, TaskMapping[TaskKind]>;
    }
  }

  /**
   * Schedules a task to be retried and returns it.
   *
   * @param taskId The ID of the task to retry.
   * @returns The task to retry.
   */
  async retry<TaskKind extends keyof TaskMapping>(
    taskId: string,
    retryAt: Date,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]>> {
    const task = Array.from(this.store.values()).find(
      (t): t is Task<TaskKind, TaskMapping[TaskKind]> => t.id === taskId && t.status === TaskStatus.CLAIMED,
    );

    if (task) {
      task.status = TaskStatus.PENDING;
      task.retryCount += 1;
      task.claimedAt = undefined;
      task.lastExecutedAt = new Date();
      task.scheduledAt = retryAt;

      return task;
    }

    throw new Error(`Task with id ${taskId} not found`);
  }

  /**
   * Marks a task as completed and returns the task.
   *
   * @param taskId The ID of the task to mark as completed.
   * @returns The task marked as completed.
   */
  async complete<TaskKind extends keyof TaskMapping>(taskId: string): Promise<Task<TaskKind, TaskMapping[TaskKind]>> {
    const task = Array.from(this.store.values()).find(
      (t): t is Task<TaskKind, TaskMapping[TaskKind]> => t.id === taskId,
    );

    const now = new Date();

    if (task) {
      task.status = TaskStatus.COMPLETED;
      task.completedAt = now;
      task.lastExecutedAt = now;

      return task;
    }

    throw new Error(`Task with id ${taskId} not found`);
  }

  /**
   * Marks a task as failed and returns the task.
   *
   * @param taskId The ID of the task to mark as failed.
   * @returns The task marked as failed.
   */
  async fail<TaskKind extends keyof TaskMapping>(taskId: string): Promise<Task<TaskKind, TaskMapping[TaskKind]>> {
    const task = Array.from(this.store.values()).find(
      (t): t is Task<TaskKind, TaskMapping[TaskKind]> => t.id === taskId,
    );

    if (task) {
      task.status = TaskStatus.FAILED;
      task.lastExecutedAt = new Date();

      return task;
    }

    throw new Error(`Task with id ${taskId} not found`);
  }

  /**
   * Add a task to the Dead Letter Queue
   *
   * @param task The task to move to DLQ
   * @param error Optional error that caused the task to fail
   */
  async addToDlq<TaskKind extends keyof TaskMapping>(
    task: Task<TaskKind, TaskMapping[TaskKind]>,
    error?: Error,
  ): Promise<void> {
    // Store in DLQ with retry count starting at 0
    const dlqEntry: DlqEntry<TaskKind, TaskMapping[TaskKind]> = {
      task: { ...task, status: TaskStatus.FAILED },
      error,
      dlqRetryCount: 0,
      failedAt: new Date(),
    };

    this.dlqStore.set(task.id, dlqEntry);

    // Remove from main store so it won't be processed again
    this.store.delete(task.id);
  }

  /**
   * Redrive messages from the Dead Letter Queue back into main store
   * Only redrive tasks that haven't exceeded the maximum DLQ retry limit
   */
  async redriveFromDlq<TaskKind extends keyof TaskMapping>(): Promise<Task<TaskKind, TaskMapping[TaskKind]>[]> {
    const redrivenTasks: Task<TaskKind, TaskMapping[TaskKind]>[] = [];
    const now = new Date();
    const maxRetries = this.config.maxDlqRetries ?? DEFAULT_MAX_DLQ_RETRIES;

    const entriesToRedrive = Array.from(this.dlqStore.entries()).filter(
      ([_, entry]) => entry.dlqRetryCount < maxRetries,
    );

    for (const [oldId, entry] of entriesToRedrive) {
      // Create new task with new ID and reset retry count
      const newId = (this.nextId++).toString();
      const newTask: Task<TaskKind, TaskMapping[TaskKind]> = {
        ...entry.task,
        id: newId,
        status: TaskStatus.PENDING,
        claimedAt: undefined,
        completedAt: undefined,
        retryCount: 0,
        scheduledAt: now,
        lastExecutedAt: now,
      } as Task<TaskKind, TaskMapping[TaskKind]>;

      // Check for duplicate idempotencyKey in main store
      if (newTask.idempotencyKey) {
        const duplicate = Array.from(this.store.values()).find(
          (t) => t.kind === newTask.kind && t.idempotencyKey === newTask.idempotencyKey,
        );

        if (duplicate) {
          // Task already exists in main store, just remove from DLQ
          this.dlqStore.delete(oldId);
          continue;
        }
      }

      // Add to main store with new ID
      this.store.set(newId, newTask);

      // Delete from DLQ after successful redrive
      this.dlqStore.delete(oldId);

      redrivenTasks.push(newTask);
    }

    return redrivenTasks;
  }
}