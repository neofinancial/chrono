import { EventEmitter } from 'node:stream';
import { setTimeout } from 'node:timers/promises';

import type { Datastore, ScheduleInput, Task } from './datastore';

export type ScheduleTaskInput<TaskKind, TaskData, DatastoreOptions> = ScheduleInput<
  TaskKind,
  TaskData,
  DatastoreOptions
>;

export type ChronoConfig<DatastoreOptions> = {
  datastore: Datastore<DatastoreOptions>;
  pollingInterval?: number;
  maxConcurrency?: number;
};

export class Chrono<TaskKind, DatastoreOptions> extends EventEmitter {
  #datastore: Datastore<DatastoreOptions>;
  #handlers: Map<TaskKind, (task: Task<TaskKind, unknown>) => Promise<void>> = new Map();

  /* The interval in milliseconds to poll for new tasks */
  #pollingInterval = 2000;
  /* The maximum number of tasks to process concurrently */
  #maxConcurrency = 1;

  /* Flag to indicate if the instance is stopping */
  #isStopping = false;

  constructor(config: ChronoConfig<DatastoreOptions>) {
    super();

    this.#datastore = config.datastore;

    if (config.pollingInterval) this.#pollingInterval = config.pollingInterval;
    if (config.maxConcurrency) this.#maxConcurrency = config.maxConcurrency;
  }

  public async start(): Promise<void> {
    if (this.#isStopping) {
      throw new Error('Cannot start Chrono instance while stopping');
    }

    // Start polling loop immediately in the background
    process.nextTick(() => this.#startPolling());

    // Emit ready event when the instance is ready.
    // This is useful for consumers to know when the instance is ready to accept tasks.
    // In the future, we might want to add more initialization logic here, like ensuring the datastore is connected.
    this.emit('ready', { timestamp: new Date() });
  }

  public async stop(): Promise<void> {
    this.#isStopping = true;

    // Wait for the polling loop to emit a 'stopped' event
    await new Promise<void>((resolve) => {
      this.once('polling-stopped', resolve);
    });

    // TODO: Stop and stop handlers porcessing tasks
    // TODO: Close the datastore connection ?

    // Emit close event
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

  async #startPolling(): Promise<void> {
    while (!this.#isStopping) {
      const claimResults = await Promise.allSettled(
        Array.from({ length: this.#maxConcurrency }).map(() => this.#datastore.claim<TaskKind, unknown>()),
      );

      const claimedTasks = claimResults.filter((result) => result.status === 'fulfilled');

      this.emit('task-claimed', { claimedTasks, timestamp: new Date() });

      await Promise.allSettled(claimedTasks.map((result) => this.#processTask(result.value)));

      await setTimeout(this.#pollingInterval);
    }

    // Emit 'polling-stopped' event when the polling loop exits
    this.emit('polling-stopped');
  }

  async #processTask(task: Task<TaskKind, unknown>): Promise<void> {
    const handler = this.#handlers.get(task.kind);

    if (!handler) {
      await this.#datastore.fail(task.id, new Error(`No handler for task kind: ${task.kind}`));
      this.emit('task-failed', {
        task,
        error: new Error(`No handler for task kind: ${task.kind}`),
        timestamp: new Date(),
      });

      return;
    }

    try {
      await handler(task);
      await this.#datastore.complete(task.id);
      this.emit('task-completed', { task, timestamp: new Date() });
    } catch (error) {
      await this.#datastore.fail(task.id, error as Error);
      this.emit('task-failed', { task, error, timestamp: new Date() });
    }
  }
}
