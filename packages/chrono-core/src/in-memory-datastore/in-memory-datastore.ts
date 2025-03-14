import type { Datastore, ScheduleInput, Task } from '../datastore';

export type InMemoryDatastoreOptions = Record<string, unknown>;

export type InMemoryDatastoreTask<TaskKind, TaskData> = Task<TaskKind, TaskData> & {
  priority: number;
};

export class InMemoryDatastore implements Datastore<InMemoryDatastoreOptions> {
  #store: Map<string, InMemoryDatastoreTask<unknown, unknown>>;

  constructor() {
    this.#store = new Map();
  }

  public async schedule<TaskKind, TaskData>(
    input: ScheduleInput<TaskKind, TaskData, InMemoryDatastoreOptions>,
  ): Promise<Task<TaskKind, TaskData>> {
    if (input.idempotencyKey) {
      const existingTask = Array.from(this.#store.values()).find((t) => t.idempotencyKey === input.idempotencyKey);

      if (existingTask) {
        return existingTask as InMemoryDatastoreTask<TaskKind, TaskData>;
      }
    }

    const id = this.#store.size.toString();

    const task: InMemoryDatastoreTask<TaskKind, TaskData> = {
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
