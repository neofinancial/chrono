import type { Datastore, ScheduleInput, Task, TaskMappingBase } from '@neofinancial/chrono-core';
import type { ClaimTaskInput } from '@neofinancial/chrono-core/build/datastore';

export type ChronoMemoryDatastoreTask<TaskKind, TaskData> = Task<TaskKind, TaskData> & {
  priority: number;
};

export class ChronoMemoryDatastore<TaskMapping extends TaskMappingBase, MemoryDatastoreOptions>
  implements Datastore<keyof TaskMapping, TaskMapping[keyof TaskMapping], MemoryDatastoreOptions>
{
  private store: Map<string, ChronoMemoryDatastoreTask<keyof TaskMapping, TaskMapping[keyof TaskMapping]>>;

  constructor() {
    this.store = new Map();
  }

  public async schedule<TK extends keyof TaskMapping, TD extends TaskMapping[keyof TaskMapping]>(
    input: ScheduleInput<TK, TD, MemoryDatastoreOptions>,
  ): Promise<Task<TK, TD>> {
    if (input.idempotencyKey) {
      const existingTask = Array.from(this.store.values()).find((t) => t.idempotencyKey === input.idempotencyKey);

      if (existingTask) {
        return Promise.resolve(existingTask as Task<TK, TD>);
      }
    }

    const id = this.store.size.toString();

    const task: ChronoMemoryDatastoreTask<TK, TD> = {
      id,
      kind: input.kind,
      status: 'pending',
      data: input.data,
      priority: input.priority ?? 0,
      idempotencyKey: input.idempotencyKey,
      originalScheduleDate: input.when,
      scheduledAt: input.when,
    };

    this.store.set(id, task);

    return task;
  }

  public async claim<TaskKind, TaskData>(
    input: ClaimTaskInput<TaskKind>,
  ): Promise<Task<TaskKind, TaskData> | undefined> {
    const claimedTask = Array.from(this.store.values()).find((t) => t.kind === input.kind && t.status === 'pending');

    if (claimedTask) {
      claimedTask.status = 'claimed';
    }

    return claimedTask as Task<TaskKind, TaskData>;
  }
  public async complete<TaskKind, TaskData>(taskId: string): Promise<Task<TaskKind, TaskData>> {
    const task = Array.from(this.store.values()).find((t) => t.id === taskId);

    if (task) {
      task.status = 'completed';

      return task as Task<TaskKind, TaskData>;
    }

    throw new Error(`Task with id ${taskId} not found`);
  }
  public async fail<TaskKind, TaskData>(taskId: string, error: Error): Promise<Task<TaskKind, TaskData>> {
    const task = Array.from(this.store.values()).find((t) => t.id === taskId);

    if (task) {
      task.status = 'failed';

      return task as Task<TaskKind, TaskData>;
    }

    throw new Error(`Task with id ${taskId} not found`);
  }
}
