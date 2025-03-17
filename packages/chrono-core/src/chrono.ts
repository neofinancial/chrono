import { EventEmitter } from 'node:stream';

import type { Datastore, ScheduleInput, Task } from './datastore';

export type ScheduleTaskInput<TaskKind, TaskData, DatastoreOptions> = ScheduleInput<
  TaskKind,
  TaskData,
  DatastoreOptions
>;

export class Chrono<TaskKind, DatastoreOptions> extends EventEmitter {
  #datastore: Datastore<DatastoreOptions>;

  constructor(datastore: Datastore<DatastoreOptions>) {
    super();

    this.#datastore = datastore;
  }

  public async start(): Promise<void> {
    // Emit ready event when the instance is ready.
    // This is useful for consumers to know when the instance is ready to accept tasks.
    // In the future, we might want to add more initialization logic here, like ensuring the datastore is connected.
    this.emit('ready', { timestamp: new Date() });
  }

  public async stop(): Promise<void> {
    // Emit close event when the instance is closed.
    // This is useful for consumers to know when the instance is closed and no longer accepting tasks.
    // In the future, we might want to add more cleanup logic here, like closing the datastore connection
    // and stopping all handlers.
    this.emit('close', { timestamp: new Date() });
  }

  public async scheduleTask<TaskData>(
    input: ScheduleTaskInput<TaskKind, TaskData, DatastoreOptions>,
  ): Promise<Task<TaskKind, TaskData>> {
    try {
      const task = await this.#datastore.schedule({
        when: input.when,
        kind: input.kind,
        data: input.data,
        datastoreOptions: input.datastoreOptions,
      });

      this.emit('task-scheduled', { task, timestamp: new Date() });

      return task;
    } catch (error) {
      this.emit('task-schedule-failed', { error, input, timestamp: new Date() });

      throw error;
    }
  }
}
