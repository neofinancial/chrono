import { EventEmitter } from 'node:events';

import type { BackoffStrategyOptions } from './backoff-strategy';
import type { Datastore, ScheduleInput, Task } from './datastore';
import { ChronoEvents, type ChronoEventsMap } from './events';
import type { ChronoPlugin } from './plugins';
import { ChronoPluginContext } from './plugins/chrono-plugin-context';
import { createProcessor, type Processor } from './processors';
import type { ProcessorConfiguration } from './processors/create-processor';
import type { ProcessorEventsMap } from './processors/events';
import { promiseWithTimeout } from './utils/promise-utils';

export type TaskMappingBase = Record<string, unknown>;

export type ScheduleTaskInput<TaskKind, TaskData, DatastoreOptions> = ScheduleInput<
  TaskKind,
  TaskData,
  DatastoreOptions
>;

export type RegisterTaskHandlerInput<TaskKind, TaskData> = {
  /** The type of task */
  kind: TaskKind;
  /** The handler function to process the task */
  handler: (task: Task<TaskKind, TaskData>) => Promise<void>;
  /** The options for the backoff strategy to use when the task handler fails */
  backoffStrategyOptions?: BackoffStrategyOptions;
  /** The configuration for the processor to use when processing the task */
  processorConfiguration?: ProcessorConfiguration;
};

/**
 * Response from registering a task handler.
 * @returns The processor instance that can be used to start and stop the processor.
 */
export type RegisterTaskHandlerResponse<
  TaskKind extends keyof TaskMapping,
  TaskMapping extends TaskMappingBase,
> = EventEmitter<ProcessorEventsMap<TaskKind, TaskMapping>>;

/**
 * A covariant interface exposing only task handler registration.
 *
 * Because `registerTaskHandler` only puts `TaskMapping` in covariant positions
 * (task data flows *out* to the handler callback), this interface can be annotated
 * `out TaskMapping`. This lets a `Chrono<BigMapping>` satisfy
 * `ChronoHandlerRegistrar<SmallMapping>` whenever `BigMapping extends SmallMapping`,
 * which is the key property needed to pass a single wide Chrono to multiple
 * narrowly-typed outbox handlers without any casts.
 */
export interface ChronoHandlerRegistrar<out TaskMapping extends TaskMappingBase> {
  registerTaskHandler<TaskKind extends Extract<keyof TaskMapping, string>>(
    input: RegisterTaskHandlerInput<TaskKind, TaskMapping[TaskKind]>,
  ): RegisterTaskHandlerResponse<TaskKind, TaskMapping>;
}

/**
 * The main class for scheduling and processing tasks.
 * @param datastore - The datastore instance to use for storing and retrieving tasks.
 * @returns The Chrono instance that can be used to start and stop the processors as well as receive chrono instance events.
 */
export class Chrono<TaskMapping extends TaskMappingBase, DatastoreOptions>
  extends EventEmitter<ChronoEventsMap>
  implements ChronoHandlerRegistrar<TaskMapping>
{
  private readonly datastore: Datastore<TaskMapping, DatastoreOptions>;
  private readonly processors: Map<keyof TaskMapping, Processor<keyof TaskMapping, TaskMapping>> = new Map();
  private readonly pluginContexts: ChronoPluginContext<TaskMapping, DatastoreOptions>[] = [];
  private started = false;

  readonly exitTimeoutMs = 60_000;

  constructor(datastore: Datastore<TaskMapping, DatastoreOptions>) {
    super();

    this.datastore = datastore;
  }

  /**
   * Register a plugin with Chrono.
   * Plugins must be registered before calling start().
   * @param plugin - The plugin to register
   * @returns The plugin's API (if any) for type-safe access to plugin functionality
   */
  use<PluginAPI>(plugin: ChronoPlugin<TaskMapping, DatastoreOptions, PluginAPI>): PluginAPI {
    if (this.started) {
      throw new Error(`Cannot register plugin "${plugin.name}" after Chrono has started`);
    }

    const context = new ChronoPluginContext<TaskMapping, DatastoreOptions>(this, this.processors, this.datastore);

    const api = plugin.register(context);

    this.pluginContexts.push(context);

    return api;
  }

  public async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;

    for (const context of this.pluginContexts) {
      await context.executeStartHooks();
    }

    for (const processor of this.processors.values()) {
      await processor.start();
    }

    this.emit(ChronoEvents.STARTED, { startedAt: new Date() });
  }

  public async stop(): Promise<void> {
    // Execute plugin stop hooks first (in reverse order - LIFO)
    for (const context of [...this.pluginContexts].reverse()) {
      await context.executeStopHooks();
    }

    const stopPromises = Array.from(this.processors.values()).map((processor) => processor.stop());

    try {
      await promiseWithTimeout(Promise.all(stopPromises), this.exitTimeoutMs);
    } catch (error) {
      this.emit(ChronoEvents.STOP_ABORTED, { error, timestamp: new Date() });
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
  ): RegisterTaskHandlerResponse<TaskKind, TaskMapping> {
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
