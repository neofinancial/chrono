import type {
  ClaimInput,
  CompleteInput,
  DataStore,
  ScheduleInput,
  Task,
  UnClaimInput,
} from "@neofinancial/chrono-core";
import { randomUUID } from "node:crypto";

interface ChronoInMemoryDataStoreOptions {
  // In-memory data store options
  name: "ChronoInMemoryDataStore";
}

export class ChronoInMemoryDataStore
  implements DataStore<ChronoInMemoryDataStoreOptions>
{
  private store: Map<string, Task<object>> = new Map();

  schedule(
    input: ScheduleInput<object>,
    _options: ChronoInMemoryDataStoreOptions
  ): Promise<Task<object>> {
    const id = randomUUID();
    const task: Task<object> = {
      id,
      type: input.type,
      data: input.data,
      priority: input.priority || 20,
      status: "PENDING",
      scheduledAt: input.scheduledAt,
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
  unclaim(
    input: UnClaimInput,
    options: ChronoInMemoryDataStoreOptions
  ): Promise<Task<object> | undefined> {
    throw new Error("Method not implemented.");
  }
  complete(
    input: CompleteInput,
    options: ChronoInMemoryDataStoreOptions
  ): Promise<Task<object>> {
    throw new Error("Method not implemented.");
  }
}
