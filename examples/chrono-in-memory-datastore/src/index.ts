import { randomUUID } from "node:crypto";
import type { Datastore, ScheduleInput, Task } from "@neofinancial/chrono-core";

interface ChronoInMemoryDataStoreOptions {
  // In-memory data store options
  name: "ChronoInMemoryDataStore";
}

export class ChronoInMemoryDataStore
  implements Datastore<ChronoInMemoryDataStoreOptions>
{
  private store: Map<string, Task<any, object>> = new Map();

  schedule(
    input: ScheduleInput<any, object, any>,
    _options: ChronoInMemoryDataStoreOptions
  ): Promise<Task<any, object>> {
    const id = randomUUID();
    const task: Task<any, object> = {
      id,
      type: input.type,
      data: input.data,
      priority: input.priority || 20,
      status: "pending",
      retryCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.store.set(id, task);

    return Promise.resolve(task);
  }
  unschedule(
    taskId: string,
    _options: ChronoInMemoryDataStoreOptions
  ): Promise<Task<object> | undefined> {
    const task = this.store.get(taskId);

    if (task) {
      this.store.delete(taskId);
    }

    return Promise.resolve(task);
  }
  claim(
    _input: ClaimInput,
    _options: ChronoInMemoryDataStoreOptions
  ): Promise<Task<object> | undefined> {
    const now = new Date();
    const task = [...this.store.values()]
      .filter(
        (task) =>
          (task.status === "PENDING" && task.scheduledAt <= now) ||
          (task.status === "CLAIMED" &&
            task.scheduledAt <= now &&
            task.claimedAt &&
            task.claimedAt.getTime() <= now.getTime() + 10000)
      )
      .sort(
        (a, b) =>
          a.priority - b.priority ||
          a.createdAt.getTime() - b.createdAt.getTime()
      )
      .pop();

    if (!task) {
      return Promise.resolve(undefined);
    }

    const updatedTask: Task<object> = {
      ...task,
      status: "CLAIMED",
      claimedAt: now,
      updatedAt: now,
    };

    this.store.set(task.id, updatedTask);

    return Promise.resolve(updatedTask);
  }
}
