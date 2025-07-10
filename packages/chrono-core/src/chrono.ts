import { EventEmitter } from 'node:stream';

import type { BackoffStrategyOptions } from './backoff-strategy';
import type { Datastore, ScheduleInput, Task } from './datastore';
import { ChronoEvents, type ChronoEventsMap } from './events';
import { type Processor, createProcessor } from './processors';
import type { ProcessorConfiguration } from './processors/create-processor';
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
  processorConfiguration?: ProcessorConfiguration;
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

export class Chrono<TaskMapping extends TaskMappingBase, DatastoreOptions> extends EventEmitter<ChronoEventsMap> {
  private datastore: Datastore<TaskMapping, DatastoreOptions>;
  private processors: Map<keyof TaskMapping, Processor<keyof TaskMapping, TaskMapping>> = new Map();

  readonly exitTimeoutMs = 60_000;

  constructor(datastore: Datastore<TaskMapping, DatastoreOptions>) {
    super();

    this.datastore = datastore;
  }

  public async start(): Promise<void> {
    for (const processor of this.processors.values()) {
      await processor.start();
    }

    this.emit(ChronoEvents.STARTED, { startedAt: new Date() });
  }

  public async stop(): Promise<void> {
    const stopPromises = Array.from(this.processors.values()).map((processor) => processor.stop());

    try {
      await promiseWithTimeout(Promise.all(stopPromises), this.exitTimeoutMs);
    } catch (error) {
      this.emit(ChronoEvents.FORCIBLY_STOPPED, { error, timestamp: new Date() });
    }
  }

  public async scheduleTask<TaskKind extends keyof TaskMapping>(
    input: ScheduleTaskInput<TaskKind, TaskMapping[TaskKind], DatastoreOptions>,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]>> {
    const task = await this.datastore.schedule({
      when: input.when,
      kind: input.kind,
      data: input.data,
      datastoreOptions: input.datastoreOptions,
    });

    return task;
  }

  public async deleteTask<TaskKind extends keyof TaskMapping>(
    taskId: string,
  ): Promise<Task<TaskKind, TaskMapping[TaskKind]> | undefined> {
    const task = await this.datastore.delete<TaskKind>(taskId);

    return task;
  }

  public registerTaskHandler<TaskKind extends Extract<keyof TaskMapping, string>>(
    input: RegisterTaskHandlerInput<TaskKind, TaskMapping[TaskKind]>,
  ): Processor<TaskKind, TaskMapping> {
    if (this.processors.has(input.kind)) {
      throw new Error('Handler for task kind already exists');
    }

    const processor = createProcessor({
      kind: input.kind,
      datastore: this.datastore,
      handler: input.handler,
      backoffStrategyOptions: input.backoffStrategyOptions,
      configuration: input.processorConfiguration,
    });

    this.processors.set(input.kind, processor);

    return processor;
  }
}
