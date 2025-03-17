import type { Datastore, ScheduleInput, Task } from '@neofinancial/chrono-core';

export type MemoryDatastoreOptions = Record<string, unknown>;

export type MemoryDatastoreTask<TaskKind, TaskData> = Task<TaskKind, TaskData> & {
  priority: number;
};

export class MemoryDatastore implements Datastore<MemoryDatastoreOptions> {
  #store: Map<string, MemoryDatastoreTask<unknown, unknown>>;

  constructor() {
    this.#store = new Map();
  }

  public async schedule<TaskKind, TaskData>(
    input: ScheduleInput<TaskKind, TaskData, MemoryDatastoreOptions>,
  ): Promise<Task<TaskKind, TaskData>> {
    if (input.idempotencyKey) {
      const existingTask = Array.from(this.#store.values()).find((t) => t.idempotencyKey === input.idempotencyKey);

      if (existingTask) {
        return existingTask as MemoryDatastoreTask<TaskKind, TaskData>;
      }
    }

    const id = this.#store.size.toString();

    const task: MemoryDatastoreTask<TaskKind, TaskData> = {
      id,
      kind: input.kind,
      status: 'pending',
      data: input.data,
      priority: input.priority ?? 0,
      idempotencyKey: input.idempotencyKey,
      originalScheduleDate: input.when,
      scheduledAt: input.when,
    };
    1;

    this.#store.set(id, task);

    return task;
  }
}
