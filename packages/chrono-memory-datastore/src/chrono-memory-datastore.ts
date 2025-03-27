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

  public async schedule<TaskKind extends keyof TaskMapping>(
    input: ScheduleInput<TaskKind, TaskMapping[TaskKind], MemoryDatastoreOptions>,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]>> {
    if (input.idempotencyKey) {
      const existingTask = Array.from(this.store.values())
        .filter((t): t is Task<TaskKind, TaskMapping[TaskKind]> => t.kind === input.kind)
        .find((t) => t?.idempotencyKey === input.idempotencyKey);

      if (existingTask) {
        return Promise.resolve(existingTask);
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
    };

    this.store.set(id, task);

    return task;
  }

  public async claim<TaskKind extends keyof TaskMapping, TaskData extends TaskMapping[keyof TaskMapping]>(
    input: ClaimTaskInput<TaskKind>,
  ): Promise<Task<TaskKind, TaskData> | undefined> {
    const claimedTask = Array.from(this.store.values()).find(
      (t) => t.kind === input.kind && t.status === TaskStatus.PENDING,
    );

    if (claimedTask) {
      claimedTask.status = TaskStatus.CLAIMED;

      return claimedTask as Task<TaskKind, TaskData>;
    }
  }

  public async complete<TaskKind extends keyof TaskMapping, TaskData extends TaskMapping[keyof TaskMapping]>(
    taskId: string,
  ): Promise<Task<TaskKind, TaskData>> {
    const task = Array.from(this.store.values()).find((t) => t.id === taskId);

    if (task) {
      task.status = TaskStatus.COMPLETED;

      return task as Task<TaskKind, TaskData>;
    }

    throw new Error(`Task with id ${taskId} not found`);
  }

  public async fail<TaskKind, TaskData>(taskId: string): Promise<Task<TaskKind, TaskData>> {
    const task = Array.from(this.store.values()).find((t) => t.id === taskId);

    if (task) {
      task.status = TaskStatus.FAILED;

      return task as Task<TaskKind, TaskData>;
    }

    throw new Error(`Task with id ${taskId} not found`);
  }
}
