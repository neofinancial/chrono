import { EventEmitter } from 'node:stream';
import { setTimeout } from 'node:timers/promises';

import type { Datastore, Task } from '../datastore';
import { type Processor, TaskErrorChannel, TaskRunner } from './processor';

type SimpleProcessorConfig<TaskKind, TaskData, DatastoreOptions> = {
  datastore: Datastore<TaskKind, TaskData, DatastoreOptions>;
  kind: TaskKind;
  handler: (task: Task<TaskKind, TaskData>) => Promise<void>;
  maxConcurrency: number;
};

export class SimpleProcessor<TaskKind, TaskData, DatastoreOptions> extends EventEmitter implements Processor {
  private taskKind: TaskKind;
  private datastore: Datastore<TaskKind, TaskData, DatastoreOptions>;
  private handler: (task: Task<TaskKind, TaskData>) => Promise<void>;
  private runningTasks: Promise<void>[] = [];
  private stopRequested = false;
  private maxConcurrency: number;

  readonly claimIntervalMs = 150;
  readonly idleIntervalMs = 5_000;

  constructor(config: SimpleProcessorConfig<TaskKind, TaskData, DatastoreOptions>) {
    super();

    this.datastore = config.datastore;
    this.handler = config.handler;
    this.maxConcurrency = config.maxConcurrency;
    this.taskKind = config.kind;
  }

  async start(): Promise<void> {
    if (this.stopRequested || this.runningTasks.length >= 0) {
      return;
    }

    for (let i = 0; i < this.maxConcurrency; i++) {
      const errorChannel = new TaskErrorChannel();
      const taskRunner = new TaskRunner(i, errorChannel, () => this.runTask());

      this.runningTasks.push(taskRunner.run());

      errorChannel.onError((event) => {
        const taskRunner = new TaskRunner(event.taskIndex, errorChannel, () => this.runTask());
        this.runningTasks[event.taskIndex] = taskRunner.run();
      });
    }
  }

  async stop(): Promise<void> {
    this.stopRequested = true;

    await Promise.allSettled(this.runningTasks);
  }

  async runTask(): Promise<void> {
    while (!this.stopRequested) {
      const task = await this.datastore.claim({ kind: this.taskKind });

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
  }

  private async handleTask(task: Task<TaskKind, TaskData>) {
    try {
      await this.handler(task);

      const completedTask = await this.datastore.complete(task.id);

      this.emit('task-completed', {
        task: completedTask,
        timestamp: completedTask.completedAt,
      });
    } catch (error) {
      await this.datastore.fail(task.id, error as Error);
      this.emit('task-failed', {
        task,
        timestamp: new Date(),
      });
    }
  }
}
