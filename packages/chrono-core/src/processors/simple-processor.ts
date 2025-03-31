import { EventEmitter } from 'node:stream';
import { setTimeout } from 'node:timers/promises';

import type { TaskMappingBase } from '..';
import type { Datastore, Task } from '../datastore';
import type { Processor } from './processor';

type SimpleProcessorConfig<
  TaskKind extends keyof TaskMapping,
  TaskMapping extends TaskMappingBase,
  DatastoreOptions,
> = {
  datastore: Datastore<TaskMapping, DatastoreOptions>;
  kind: TaskKind;
  handler: (task: Task<TaskKind, TaskMapping[TaskKind]>) => Promise<void>;
  maxConcurrency: number;
};

export class SimpleProcessor<
    TaskKind extends Extract<keyof TaskMapping, string>,
    TaskMapping extends TaskMappingBase,
    DatastoreOptions,
  >
  extends EventEmitter
  implements Processor
{
  private taskKind: TaskKind;
  private datastore: Datastore<TaskMapping, DatastoreOptions>;
  private handler: (task: Task<TaskKind, TaskMapping[TaskKind]>) => Promise<void>;
  private exitChannels: EventEmitter[] = [];
  private stopRequested = false;
  private maxConcurrency: number;

  readonly claimIntervalMs = 150;
  readonly idleIntervalMs = 5_000;

  constructor(config: SimpleProcessorConfig<TaskKind, TaskMapping, DatastoreOptions>) {
    super();

    this.datastore = config.datastore;
    this.handler = config.handler;
    this.maxConcurrency = config.maxConcurrency;
    this.taskKind = config.kind;
  }

  /**
   * Starts multiple concurrent process loops that claim and process tasks.
   * Max concurrent processes is defined by the `maxConcurrency` property set in the constructor.
   */
  async start(): Promise<void> {
    if (this.stopRequested || this.exitChannels.length > 0) {
      return;
    }

    for (let i = 0; i < this.maxConcurrency; i++) {
      const exitChannel = new EventEmitter();

      this.exitChannels.push(exitChannel);

      const errorHandler = (error: Error) => {
        this.emit('task-error', { error });

        this.runProcessLoop(exitChannel).catch(errorHandler);
      };

      this.runProcessLoop(exitChannel).catch(errorHandler);
    }
  }

  /**
   * Stops the processor by signaling all process loops to exit,
   * then waits for all process loops to finish before resolving.
   */
  async stop(): Promise<void> {
    const exitPromises = this.exitChannels.map(
      (channel) => new Promise((resolve) => channel.once('processloop.exit', resolve)),
    );

    this.stopRequested = true;

    await Promise.all(exitPromises);
  }

  /**
   * The main loop that processes tasks.
   *
   * @param exitChannel The channel to signal when the loop exits.
   */
  private async runProcessLoop(exitChannel: EventEmitter): Promise<void> {
    while (!this.stopRequested) {
      const task = await this.datastore.claim({
        kind: this.taskKind,
      });

      // If no tasks are available, wait before trying again
      if (!task) {
        await setTimeout(this.idleIntervalMs);

        continue;
      }

      // Process the task using the handler
      await this.handleTask(task);

      // Wait a bit before claiming the next task
      await setTimeout(this.claimIntervalMs);
    }

    exitChannel.emit('processloop.exit');
  }

  private async handleTask(task: Task<TaskKind, TaskMapping[TaskKind]>) {
    try {
      await this.handler(task);

      const completedTask = await this.datastore.complete(task.id);

      this.emit('task-completed', {
        task: completedTask,
        timestamp: completedTask.completedAt,
      });
    } catch (error) {
      await this.datastore.fail(task.id);
      this.emit('task-failed', {
        task,
        timestamp: new Date(),
      });
    }
  }
}
