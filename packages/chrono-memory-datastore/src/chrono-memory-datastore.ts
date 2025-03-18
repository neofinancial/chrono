import type { Datastore, ScheduleInput, Task } from '@neofinancial/chrono-core';

export type ChronoMemoryDatastoreTask<TaskKind, TaskData> = Task<TaskKind, TaskData> & {
  priority: number;
};

export class ChronoMemoryDatastore<MemoryDatastoreOptions> implements Datastore<MemoryDatastoreOptions> {
  #store: Map<string, ChronoMemoryDatastoreTask<unknown, unknown>>;

  constructor() {
    this.#store = new Map();
  }

  public async schedule<TaskKind, TaskData>(
    input: ScheduleInput<TaskKind, TaskData, MemoryDatastoreOptions>,
  ): Promise<Task<TaskKind, TaskData>> {
    if (input.idempotencyKey) {
      const existingTask = Array.from(this.#store.values()).find((t) => t.idempotencyKey === input.idempotencyKey);

      if (existingTask) {
        return existingTask as ChronoMemoryDatastoreTask<TaskKind, TaskData>;
      }
    }

    const id = this.#store.size.toString();

    const task: ChronoMemoryDatastoreTask<TaskKind, TaskData> = {
      id,
      kind: input.kind,
      status: 'pending',
      data: input.data,
      priority: input.priority ?? 0,
      idempotencyKey: input.idempotencyKey,
      originalScheduleDate: input.when,
      scheduledAt: input.when,
    };

    this.#store.set(id, task);

    return task;
  }
}
