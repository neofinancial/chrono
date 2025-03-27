import { EventEmitter } from 'node:stream';
import { setTimeout } from 'node:timers/promises';

import type { TaskMappingBase } from '..';
import type { Datastore, Task } from '../datastore';
import { type Processor, TaskRunner } from './processor';

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

export class SimpleProcessor<TaskKind extends keyof TaskMapping, TaskMapping extends TaskMappingBase, DatastoreOptions>
  extends EventEmitter
  implements Processor
{
  private taskKind: TaskKind;
  private datastore: Datastore<TaskMapping, DatastoreOptions>;
  private handler: (task: Task<TaskKind, TaskMapping[TaskKind]>) => Promise<void>;
  private runningTasks: TaskRunner[] = [];
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

  async start(): Promise<void> {
    if (this.stopRequested || this.runningTasks.length > 0) {
      return;
    }

    for (let i = 0; i < this.maxConcurrency; i++) {
      const taskRunner = new TaskRunner(i, () => this.runTask());

      this.runningTasks.push(taskRunner);

      taskRunner.onError((event) => {
        this.emit('task-runner-error', event);
        process.nextTick(() => taskRunner.run());
      });

      process.nextTick(() => taskRunner.run());
    }
  }

  async stop(): Promise<void> {
    const exitPromises = Promise.allSettled(this.runningTasks.map((taskRunner) => taskRunner.onceExit()));

    this.stopRequested = true;

    await exitPromises;
  }

  async runTask(): Promise<void> {
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
