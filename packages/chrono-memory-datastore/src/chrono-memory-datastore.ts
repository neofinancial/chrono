import {
  type ClaimTaskInput,
  type Datastore,
  type ScheduleInput,
  type Task,
  type TaskMappingBase,
  TaskStatus,
} from '@neofinancial/chrono-core';
import type { DeleteInput } from '@neofinancial/chrono-core/build/datastore';

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
   * Deletes a task from the datastore and returns it.
   *
   * @param key Information required to locate the task to delete.
   * @param force when true delete tasks of any status and noop on missing tasks.
   * @returns The deleted task.
   */
  async delete<TaskKind extends keyof TaskMapping>(
    key: DeleteInput<TaskKind>,
    force?: boolean,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]> | undefined> {
    const filter =
      typeof key === 'string'
        ? (t: Task<keyof TaskMapping, TaskMapping[keyof TaskMapping]>): t is Task<TaskKind, TaskMapping[TaskKind]> =>
            t.id === key
        : (t: Task<keyof TaskMapping, TaskMapping[keyof TaskMapping]>): t is Task<TaskKind, TaskMapping[TaskKind]> =>
            t.kind === key.kind && t.idempotencyKey === key.idempotencyKey;

    const taskToRemove = Array.from(this.store.values()).find((t) => filter(t));

    const taskIsPending = taskToRemove?.status === TaskStatus.PENDING;

    if (taskToRemove && (taskIsPending || force)) {
      this.store.delete(taskToRemove.id);

      return taskToRemove;
    }

    if (force) {
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
