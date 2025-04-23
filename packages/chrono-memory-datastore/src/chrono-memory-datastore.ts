import {
  type ClaimTaskInput,
  type Datastore,
  type ScheduleInput,
  type Task,
  type TaskMappingBase,
  TaskStatus,
} from '@neofinancial/chrono-core';

export class ChronoMemoryDatastore<TaskMapping extends TaskMappingBase, MemoryDatastoreOptions>
  implements Datastore<TaskMapping, MemoryDatastoreOptions>
{
  private store: Map<string, Task<keyof TaskMapping, TaskMapping[keyof TaskMapping]>>;

  constructor() {
    this.store = new Map();
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

    const id = this.store.size.toString();

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
   * Deletes a pending task from the datastore and returns it.
   *
   * @param taskId The id of the task to delete.
   * @returns The deleted task.
   */
  async delete<TaskKind extends keyof TaskMapping>(
    taskId: string,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]> | undefined> {
    const taskToRemove = Array.from(this.store.values()).find(
      (t): t is Task<TaskKind, TaskMapping[TaskKind]> => t.id === taskId,
    );

    if (taskToRemove && taskToRemove.status === TaskStatus.PENDING) {
      this.store.delete(taskId);

      return taskToRemove;
    }

    throw new Error(`Task ${taskId} can not be deleted as it may not exist or it's not in PENDING status.`);
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
    const claimedTask = Array.from(this.store.values()).find(
      (t): t is Task<TaskKind, TaskMapping[TaskKind]> => t.kind === input.kind && t.status === TaskStatus.PENDING,
    );

    if (claimedTask) {
      claimedTask.status = TaskStatus.CLAIMED;
      claimedTask.claimedAt = new Date();

      return claimedTask;
    }
  }

  /**
   * Unclaims a task and returns it. Primarily used for retrying tasks.
   *
   * @param taskId The ID of the task to unclaim.
   * @returns The unclaimed task.
   */
  async unclaim<TaskKind extends keyof TaskMapping>(
    taskId: string,
    nextScheduledAt: Date,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]>> {
    const task = Array.from(this.store.values()).find(
      (t): t is Task<TaskKind, TaskMapping[TaskKind]> => t.id === taskId && t.status === TaskStatus.CLAIMED,
    );

    if (task) {
      task.status = TaskStatus.PENDING;
      task.retryCount += 1;
      task.claimedAt = undefined;
      task.lastExecutedAt = new Date();
      task.scheduledAt = nextScheduledAt;

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
}
