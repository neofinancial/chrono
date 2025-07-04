import { EventEmitter } from 'node:stream';
import { setTimeout } from 'node:timers/promises';

import type { BackoffStrategy } from '../backoff-strategy';
import type { TaskMappingBase } from '../chrono';
import type { Datastore, Task } from '../datastore';
import { promiseWithTimeout } from '../utils/promise-utils';
import type { Processor, ProcessorEvents } from './processor';

const DEFAULT_CONFIG: SimpleProcessorConfig = {
  maxConcurrency: 1,
  claimIntervalMs: 50,
  claimStaleTimeoutMs: 10_000,
  idleIntervalMs: 5_000,
  taskHandlerTimeoutMs: 5_000,
  taskHandlerMaxRetries: 10,
  processLoopRetryIntervalMs: 20_000,
};

type SimpleProcessorConfig = {
  maxConcurrency: number;
  claimIntervalMs: number;
  claimStaleTimeoutMs: number;
  idleIntervalMs: number;
  taskHandlerTimeoutMs: number;
  taskHandlerMaxRetries: number;
  processLoopRetryIntervalMs: number;
};

export class SimpleProcessor<
    TaskKind extends Extract<keyof TaskMapping, string>,
    TaskMapping extends TaskMappingBase,
    DatastoreOptions,
  >
  extends EventEmitter<ProcessorEvents<TaskKind, TaskMapping>>
  implements Processor<TaskKind, TaskMapping>
{
  private config: SimpleProcessorConfig;

  private exitChannels: EventEmitter[] = [];
  private stopRequested = false;

  constructor(
    private datastore: Datastore<TaskMapping, DatastoreOptions>,
    private taskKind: TaskKind,
    private handler: (task: Task<TaskKind, TaskMapping[TaskKind]>) => Promise<void>,
    private backOffStrategy: BackoffStrategy,
    config?: Partial<SimpleProcessorConfig>,
  ) {
    super();

    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    };

    this.validatedHandlerTimeout();
  }

  /**
   * Validates that the task handler timeout is less than the claim stale timeout.
   * Throws an error if the validation fails.
   * This ensures that the task handler has enough time to complete before the task is considered stale.
   * This is important to prevent tasks from being claimed again while they are still being processed.
   *
   * @throws {Error} If the task handler timeout is greater than or equal to the claim stale timeout.
   */
  private validatedHandlerTimeout() {
    if (this.config.taskHandlerTimeoutMs >= this.config.claimStaleTimeoutMs) {
      throw new Error(
        `Task handler timeout (${this.config.taskHandlerTimeoutMs}ms) must be less than the claim stale timeout (${this.config.claimStaleTimeoutMs}ms)`,
      );
    }
  }

  /**
   * Starts multiple concurrent process loops that claim and process tasks.
   * Max concurrent processes is defined by the `maxConcurrency` property set in the constructor.
   */
  async start(): Promise<void> {
    if (this.stopRequested || this.exitChannels.length > 0) {
      return;
    }

    for (let i = 0; i < this.config.maxConcurrency; i++) {
      const exitChannel = new EventEmitter<{ 'processloop:exit': [] }>();

      this.exitChannels.push(exitChannel);
      this.runProcessLoop(exitChannel);
    }
  }

  /**
   * Stops the processor by signaling all process loops to exit,
   * then waits for all process loops to finish before resolving.
   */
  async stop(): Promise<void> {
    const exitPromises = this.exitChannels.map(
      (channel) => new Promise((resolve) => channel.once('processloop:exit', resolve)),
    );

    this.stopRequested = true;

    await Promise.all(exitPromises);
  }

  /**
   * The main loop that processes tasks.
   *
   * @param exitChannel The channel to signal when the loop exits.
   */
  private async runProcessLoop(exitChannel: EventEmitter<{ 'processloop:exit': [] }>): Promise<void> {
    while (!this.stopRequested) {
      try {
        const task = await this.datastore.claim({
          kind: this.taskKind,
          claimStaleTimeoutMs: this.config.claimStaleTimeoutMs,
        });

        // If no tasks are available, wait before trying again
        if (!task) {
          await setTimeout(this.config.idleIntervalMs);

          continue;
        }

        this.emit('task:claimed', { task, timestamp: new Date() });

        // Process the task using the handler
        await this.handleTask(task);

        // Wait a bit before claiming the next task
        await setTimeout(this.config.claimIntervalMs);
      } catch (error) {
        this.emit('processloop:error', { error: error as Error, timestamp: new Date() });

        await setTimeout(this.config.processLoopRetryIntervalMs);
      }
    }

    exitChannel.emit('processloop:exit');
  }

  /**
   * Handles a task by calling the handler and marking it as complete or failed.
   *
   * Emits:
   * - `task.completed` when the task is successfully completed.
   * - `task.failed` when the task fails.
   * - `task.complete.failed` when the task fails to mark as completed.
   *
   * @param task The task to handle.
   */
  private async handleTask(task: Task<TaskKind, TaskMapping[TaskKind]>) {
    try {
      await promiseWithTimeout(this.handler(task), this.config.taskHandlerTimeoutMs);
    } catch (error) {
      await this.handleTaskError(task, error as Error);

      return;
    }

    try {
      const completedTask = await this.datastore.complete<TaskKind>(task.id);

      this.emit('task:completed', {
        task: completedTask,
        timestamp: completedTask.completedAt || new Date(),
      });
    } catch (error) {
      this.emit('task:completion:failed', {
        error: error as Error,
        task,
        timestamp: new Date(),
      });
    }
  }

  private async handleTaskError(task: Task<TaskKind, TaskMapping[TaskKind]>, error: Error): Promise<void> {
    if (task.retryCount >= this.config.taskHandlerMaxRetries) {
      // Mark the task as failed
      await this.datastore.fail(task.id);
      this.emit('task:failed', {
        task,
        error,
        timestamp: new Date(),
      });

      return;
    }

    const delay = this.backOffStrategy({ retryAttempt: task.retryCount });
    const retryAt = new Date(Date.now() + delay);

    await this.datastore.retry(task.id, retryAt);
    this.emit('task:retry:requested', {
      task,
      error,
      timestamp: new Date(),
    });
  }
}
