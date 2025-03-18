import { EventEmitter } from 'node:stream';

import type { Datastore, ScheduleInput, Task } from './datastore';

export type ScheduleTaskInput<TaskKind, TaskData, DatastoreOptions> = ScheduleInput<
  TaskKind,
  TaskData,
  DatastoreOptions
>;

export type RegisterTaskHandlerInput<TaskKind, TaskData> = {
  kind: TaskKind;
  handler: (task: Task<TaskKind, TaskData>) => Promise<void>;
};

export class Chrono<TaskMapping extends Record<PropertyKey, unknown>, DatastoreOptions> extends EventEmitter {
  #datastore: Datastore<DatastoreOptions>;
  #handlers: Partial<{
    [Key in keyof TaskMapping]: (task: Task<Key, TaskMapping[Key]>) => Promise<void>;
  }> = {};

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

  public async scheduleTask<TaskKind extends keyof TaskMapping, TaskData extends TaskMapping[TaskKind]>(
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
      this.emit('task-schedule-failed', {
        error,
        input,
        timestamp: new Date(),
      });

      throw error;
    }
  }

  public registerTaskHandler<TaskKind extends keyof TaskMapping>(
    input: RegisterTaskHandlerInput<TaskKind, TaskMapping[TaskKind]>,
  ): void {
    this.#handlers[input.kind] = input.handler;
  }
}
