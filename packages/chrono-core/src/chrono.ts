import { EventEmitter } from 'node:stream';

import type { BackoffStrategyOptions } from './backoff-strategy';
import type { Datastore, ScheduleInput, Task } from './datastore';
import { type Processor, createProcessor } from './processors';
import { promiseWithTimeout } from './utils/promise-utils';

export type TaskMappingBase = Record<string, unknown>;

export type ScheduleTaskInput<TaskKind, TaskData, DatastoreOptions> = ScheduleInput<
  TaskKind,
  TaskData,
  DatastoreOptions
>;

export type RegisterTaskHandlerInput<TaskKind, TaskData> = {
  kind: TaskKind;
  handler: (task: Task<TaskKind, TaskData>) => Promise<void>;
  backoffStrategyOptions?: BackoffStrategyOptions;
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

    try {
      await promiseWithTimeout(Promise.all(stopPromises), this.exitTimeoutMs);
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

      this.emit('task.scheduled', { task, timestamp: new Date() });

      return task;
    } catch (error) {
      this.emit('task.schedule.failed', {
        error,
        input,
        timestamp: new Date(),
      });

      throw error;
    }
  }

  public async deleteTask<TaskKind extends keyof TaskMapping>(
    taskId: string,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]> | undefined> {
    try {
      const task = await this.datastore.delete<TaskKind>(taskId);

      this.emit('task.deleted', { task, timestamp: new Date() });

      return task;
    } catch (error) {
      this.emit('task.delete.failed', {
        error,
        taskId,
        timestamp: new Date(),
      });

      throw error;
    }
  }

  public registerTaskHandler<TaskKind extends Extract<keyof TaskMapping, string>>(
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
