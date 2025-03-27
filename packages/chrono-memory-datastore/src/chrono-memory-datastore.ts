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

  public claim<TaskKind extends keyof TaskMapping, TaskData extends TaskMapping[keyof TaskMapping]>(
    _input: ClaimTaskInput<TaskKind>,
  ): Promise<Task<TaskKind, TaskData> | undefined> {
    throw new Error('Method not implemented.');
  }
  public complete<TaskKind extends keyof TaskMapping, TaskData extends TaskMapping[keyof TaskMapping]>(
    _taskId: string,
  ): Promise<Task<TaskKind, TaskData>> {
    throw new Error('Method not implemented.');
  }
  public fail<TaskKind, TaskData>(_taskId: string): Promise<Task<TaskKind, TaskData>> {
    throw new Error('Method not implemented.');
  }
}
