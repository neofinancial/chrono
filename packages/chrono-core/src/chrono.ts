import { EventEmitter } from 'node:stream';

import type { TaskMappingBase } from '.';
import type { Datastore, ScheduleInput, Task } from './datastore';
import { type Processor, createProcessor } from './processors';

export type ScheduleTaskInput<TaskKind, TaskData, DatastoreOptions> = ScheduleInput<
  TaskKind,
  TaskData,
  DatastoreOptions
>;

export type RegisterTaskHandlerInput<TaskKind, TaskData> = {
  kind: TaskKind;
  handler: (task: Task<TaskKind, TaskData>) => Promise<void>;
};

/*
type TaskMapping = {
  "async-messaging": { someField: number };
  "send-email": { url: string };
};
*/

export class Chrono<TaskMapping extends TaskMappingBase, DatastoreOptions> extends EventEmitter {
  private datastore: Datastore<
    keyof TaskMapping, // "async-messaging" | "send-email"
    TaskMapping[keyof TaskMapping], // { someField: number } | { url: string }
    DatastoreOptions
  >;
  private processors: Map<keyof TaskMapping, Processor> = new Map();

  constructor(datastore: Datastore<keyof TaskMapping, TaskMapping[keyof TaskMapping], DatastoreOptions>) {
    super();

    this.datastore = datastore;
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
      const task = await this.datastore.schedule({
        when: input.when,
        kind: input.kind,
        data: input.data,
        datastoreOptions: input.datastoreOptions,
      });

      this.emit('task-scheduled', { task, timestamp: new Date() });

      return task as Task<TaskKind, TaskData>; // TODO
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
    if (this.processors.has(input.kind)) {
      throw new Error('Handler for task kind already exists');
    }

    const processor = createProcessor<TaskKind, TaskMapping[TaskKind], DatastoreOptions>({
      kind: input.kind,
      datastore: this.datastore as Datastore<TaskKind, TaskMapping[TaskKind], DatastoreOptions>, // TODO
      handler: input.handler,
      configuration: { maxConcurrency: 1 },
    });

    this.processors.set(input.kind, processor);
  }
}
