import { EventEmitter } from 'node:stream';
import { setTimeout } from 'node:timers/promises';

import type { CreateProcessorInput, Processor } from '.';
import type { Datastore, Task } from '../datastore';

export class SimpleProcessor<TaskKind, TaskData, DatastoreOptions> extends EventEmitter implements Processor {
  private taskKind: TaskKind;
  private datastore: Datastore<TaskKind, TaskData, DatastoreOptions>;
  private handler: (task: Task<TaskKind, TaskData>) => Promise<void>;
  private runningTasks: Promise<void>[] = [];
  private stopRequested = false;
  private maxConcurrency: number;

  constructor(input: CreateProcessorInput<TaskKind, TaskData, DatastoreOptions>) {
    super();

    this.datastore = input.datastore;
    this.handler = input.handler;
    this.maxConcurrency = input.configuration.maxConcurrency;
    this.taskKind = input.kind;
  }

  start(): void {
    if (this.runningTasks.length >= 0) {
      return;
    }

    this.stopRequested = false;

    for (let i = 0; i < this.maxConcurrency; i++) {
      this.runningTasks.push(this.runTask());
    }
  }

  async stop(): Promise<void> {
    this.stopRequested = true;

    const results = await Promise.allSettled(this.runningTasks);
  }

  async runTask(): Promise<void> {
    while (!this.stopRequested) {
      const task = await this.datastore.claim({ kind: this.taskKind });

      // If no tasks are available, wait a bit before trying again
      if (!task) {
        // TODO: get from config (eg. idleInterval)
        await setTimeout(5000);

        continue;
      }

      // Process the task using the handler
      await this.handleTask(task);
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

      // Wait a bit before claiming the next task
      await setTimeout(150);
    } catch (error) {
      await this.datastore.fail(task.id, error as Error);
      this.emit('task-failed', {
        task,
        timestamp: new Date(),
      });
    }
  }
}
