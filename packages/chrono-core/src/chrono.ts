import { EventEmitter } from 'node:stream';

import type { Datastore, ScheduleInput, Task } from './datastore';
import { type Processor, createProcessor } from './processors';

export type TaskMappingBase = Record<PropertyKey, unknown>;

export type ScheduleTaskInput<TaskKind, TaskData, DatastoreOptions> = ScheduleInput<
  TaskKind,
  TaskData,
  DatastoreOptions
>;

export type RegisterTaskHandlerInput<TaskKind, TaskData> = {
  kind: TaskKind;
  handler: (task: Task<TaskKind, TaskData>) => Promise<void>;
};

/**
 * This is a type that represents the mapping of task kinds to their respective data types.
 *
 * Eg. shape of the TaskMapping type:
 *
 * type TaskMapping = {
 *   "async-messaging": { someField: number };
 *   "send-email": { url: string };
 * };
 *
 */

export class Chrono<TaskMapping extends TaskMappingBase, DatastoreOptions> extends EventEmitter {
  private datastore: Datastore<TaskMapping, DatastoreOptions>;
  private processors: Map<keyof TaskMapping, Processor> = new Map();

  readonly exitTimeoutMs = 60_000;

  constructor(datastore: Datastore<TaskMapping, DatastoreOptions>) {
    super();

    this.datastore = datastore;
  }

  public async start(): Promise<void> {
    for (const processor of this.processors.values()) {
      await processor.start();
    }

    this.emit('ready', { timestamp: new Date() });
  }

  public async stop(): Promise<void> {
    const stopPromises = Array.from(this.processors.values()).map((processor) => processor.stop());

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject('Process loop exit timeout'), this.exitTimeoutMs),
    );

    try {
      await Promise.race([Promise.all(stopPromises), timeoutPromise]);
    } catch (error) {
      this.emit('stop.failed', { error, timestamp: new Date() });
    } finally {
      this.emit('close', { timestamp: new Date() });
    }
  }

  public async scheduleTask<TaskKind extends keyof TaskMapping>(
    input: ScheduleTaskInput<TaskKind, TaskMapping[TaskKind], DatastoreOptions>,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]>> {
    try {
      const task = await this.datastore.schedule({
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
  ): Processor {
    if (this.processors.has(input.kind)) {
      throw new Error('Handler for task kind already exists');
    }

    const processor = createProcessor({
      kind: input.kind,
      datastore: this.datastore,
      handler: input.handler,
      configuration: { maxConcurrency: 1 },
    });

    this.processors.set(input.kind, processor);

    return processor;
  }
}
