import { EventEmitter } from 'node:stream';
import { setTimeout } from 'node:timers/promises';

import type { BackoffStrategy } from '../backoff-strategy';
import type { TaskMappingBase } from '../chrono';
import type { Datastore, Task } from '../datastore';
import { promiseWithTimeout } from '../utils/promise-utils';
import type { Processor, ProcessorEvents } from './processor';

const DEFAULT_MAX_CONCURRENCY = 1;
const DEFAULT_CLAIM_INTERVAL_MS = 50;
const DEFAULT_CLAIM_STALE_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_INTERVAL_MS = 5_000;
const DEFAULT_TASK_HANDLER_TIMEOUT_MS = 5_000;
const DEFAULT_TASK_HANDLER_MAX_RETRIES = 10;

type SimpleProcessorConfig<
  TaskKind extends keyof TaskMapping,
  TaskMapping extends TaskMappingBase,
  DatastoreOptions,
> = {
  datastore: Datastore<TaskMapping, DatastoreOptions>;
  kind: TaskKind;
  handler: (task: Task<TaskKind, TaskMapping[TaskKind]>) => Promise<void>;
  maxConcurrency?: number;
  backoffStrategy: BackoffStrategy;
  claimIntervalMs?: number;
  claimStaleTimeoutMs?: number;
  idleIntervalMs?: number;
  taskHandlerTimeoutMs?: number;
  taskHandlerMaxClaimAttempts?: number;
};

export class SimpleProcessor<
    TaskKind extends Extract<keyof TaskMapping, string>,
    TaskMapping extends TaskMappingBase,
    DatastoreOptions,
  >
  extends EventEmitter<ProcessorEvents<TaskKind, TaskMapping>>
  implements Processor<TaskKind, TaskMapping>
{
  readonly taskKind: TaskKind;
  readonly datastore: Datastore<TaskMapping, DatastoreOptions>;
  readonly handler: (task: Task<TaskKind, TaskMapping[TaskKind]>) => Promise<void>;

  private maxConcurrency: number;
  private backOffStrategy: BackoffStrategy;

  readonly claimIntervalMs: number;
  readonly claimStaleTimeoutMs: number;
  readonly idleIntervalMs: number;

  readonly taskHandlerTimeoutMs: number;
  readonly taskHandlerMaxClaimAttempts: number;

  private exitChannels: EventEmitter[] = [];
  private stopRequested = false;

  constructor(config: SimpleProcessorConfig<TaskKind, TaskMapping, DatastoreOptions>) {
    super();

    this.datastore = config.datastore;
    this.handler = config.handler;
    this.taskKind = config.kind;
    this.backOffStrategy = config.backoffStrategy;

    this.maxConcurrency = config.maxConcurrency || DEFAULT_MAX_CONCURRENCY;
    this.claimIntervalMs = config.claimIntervalMs || DEFAULT_CLAIM_INTERVAL_MS;
    this.claimStaleTimeoutMs = config.claimStaleTimeoutMs || DEFAULT_CLAIM_STALE_TIMEOUT_MS;
    this.idleIntervalMs = config.idleIntervalMs || DEFAULT_IDLE_INTERVAL_MS;
    this.taskHandlerTimeoutMs = config.taskHandlerTimeoutMs || DEFAULT_TASK_HANDLER_TIMEOUT_MS;
    this.taskHandlerMaxClaimAttempts = config.taskHandlerMaxClaimAttempts || DEFAULT_TASK_HANDLER_MAX_RETRIES;

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
    if (this.taskHandlerTimeoutMs >= this.claimStaleTimeoutMs) {
      throw new Error(
        `Task handler timeout (${this.taskHandlerTimeoutMs}ms) must be less than the claim stale timeout (${this.claimStaleTimeoutMs}ms)`,
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

    for (let i = 0; i < this.maxConcurrency; i++) {
      const exitChannel = new EventEmitter<{ 'processloop:exit': [] }>();

      this.exitChannels.push(exitChannel);

      const errorHandler = (error: Error) => {
        // this.emit('processloop.error', { error });

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
  private async runProcessLoop(exitChannel: EventEmitter<{ 'processloop:exit': [] }>): Promise<void> {
    while (!this.stopRequested) {
      const task = await this.datastore.claim({
        kind: this.taskKind,
        claimStaleTimeoutMs: this.claimStaleTimeoutMs,
      });

      // If no tasks are available, wait before trying again
      if (!task) {
        await setTimeout(this.idleIntervalMs);

        continue;
      }

      this.emit('task:claimed', { task, timestamp: new Date() });

      // Process the task using the handler
      await this.handleTask(task);

      // Wait a bit before claiming the next task
      await setTimeout(this.claimIntervalMs);
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
      await promiseWithTimeout(this.handler(task), this.taskHandlerTimeoutMs);
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
        error,
        task,
        timestamp: new Date(),
      });
    }
  }

  private async handleTaskError(task: Task<TaskKind, TaskMapping[TaskKind]>, error: Error): Promise<void> {
    if (task.claimCount >= this.taskHandlerMaxClaimAttempts) {
      // Mark the task as failed
      await this.datastore.fail(task.id);
      this.emit('task:failed', {
        task,
        error,
        timestamp: new Date(),
      });

      return;
    }

    const delay = this.backOffStrategy({ retryAttempt: task.claimCount });
    const nextScheduledAt = new Date(Date.now() + delay);

    await this.datastore.reschedule(task.id, nextScheduledAt);
    this.emit('task:reschedule', {
      task,
      error,
      timestamp: new Date(),
    });
  }
}
