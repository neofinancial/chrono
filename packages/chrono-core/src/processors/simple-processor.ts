import { EventEmitter } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import type { BackoffStrategy } from '../backoff-strategy';
import type { TaskMappingBase } from '../chrono';
import type { Datastore, Task } from '../datastore';
import { promiseWithTimeout } from '../utils/promise-utils';
import { ProcessorEvents, type ProcessorEventsMap } from './events';
import type { Processor } from './processor';

const DEFAULT_CONFIG: SimpleProcessorConfig = {
  maxConcurrency: 1,
  claimIntervalMs: 50,
  idleIntervalMs: 5_000,
  claimStaleTimeoutMs: 10_000,
  taskHandlerTimeoutMs: 5_000,
  taskHandlerMaxRetries: 5,
  processLoopRetryIntervalMs: 20_000,
};

type SimpleProcessorConfig = {
  /** The maximum number of concurrent tasks that the processor will use when processing. @default 1 */
  maxConcurrency: number;
  /** The interval at which the processor will wait before next poll when the previous poll returned a task @default 50ms */
  claimIntervalMs: number;
  /** The maximum time a task can be claimed for processing before it will be considered stale and claimed again @default 10000ms */
  claimStaleTimeoutMs: number;
  /** The interval at which the processor will wait before next poll when no tasks are available for processing @default 5000ms */
  idleIntervalMs: number;
  /** The maximum time a task handler can take to complete before it will be considered timed out @default 5000ms */
  taskHandlerTimeoutMs: number;
  /** The maximum number of retries for a task handler, before task is marked as failed. @default 5 */
  taskHandlerMaxRetries: number;
  /** The interval at which the processor will wait before next poll when an unexpected error occurs @default 20000ms */
  processLoopRetryIntervalMs: number;
};

const InternalProcessorEvents = { PROCESSOR_LOOP_EXIT: 'processorLoopExit' } as const;

type InternalProcessorEventsMap = {
  [InternalProcessorEvents.PROCESSOR_LOOP_EXIT]: [];
};

export class SimpleProcessor<
    TaskKind extends Extract<keyof TaskMapping, string>,
    TaskMapping extends TaskMappingBase,
    DatastoreOptions,
  >
  extends EventEmitter<ProcessorEventsMap<TaskKind, TaskMapping>>
  implements Processor<TaskKind, TaskMapping>
{
  private config: SimpleProcessorConfig;
  private exitChannels: EventEmitter<InternalProcessorEventsMap>[] = [];
  private stopRequested = false;

  constructor(
    private datastore: Datastore<TaskMapping, DatastoreOptions>,
    private taskKind: TaskKind,
    private handler: (task: Task<TaskKind, TaskMapping[TaskKind]>) => Promise<void>,
    private backOffStrategy: BackoffStrategy,
    config?: Partial<SimpleProcessorConfig>,
  ) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
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
    if (this.stopRequested || this.exitChannels.length > 0) return;

    for (let i = 0; i < this.config.maxConcurrency; i++) {
      const exitChannel = new EventEmitter<InternalProcessorEventsMap>();
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
      (channel) =>
        new Promise((resolve) => channel.once(InternalProcessorEvents.PROCESSOR_LOOP_EXIT, () => resolve(null))),
    );
    this.stopRequested = true;

    await Promise.all(exitPromises);
  }

  /**
   * The main loop that processes tasks.
   *
   * @param exitChannel The channel to signal when the loop exits.
   */
  private async runProcessLoop(exitChannel: EventEmitter<InternalProcessorEventsMap>): Promise<void> {
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

        this.emit(ProcessorEvents.TASK_CLAIMED, { task, claimedAt: task.claimedAt || new Date() });

        // Process the task using the handler
        await this.handleTask(task);

        // Wait a bit before claiming the next task
        await setTimeout(this.config.claimIntervalMs);
      } catch (error) {
        this.emit(ProcessorEvents.UNKNOWN_PROCESSING_ERROR, { error, timestamp: new Date() });
        await setTimeout(this.config.processLoopRetryIntervalMs);
      }
    }

    exitChannel.emit(InternalProcessorEvents.PROCESSOR_LOOP_EXIT);
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
      this.emit(ProcessorEvents.TASK_COMPLETED, {
        task: completedTask,
        completedAt: completedTask.completedAt || new Date(),
      });
    } catch (error) {
      this.emit(ProcessorEvents.TASK_COMPLETION_FAILURE, {
        error,
        failedAt: new Date(),
        task,
      });
    }
  }

  private async handleTaskError(task: Task<TaskKind, TaskMapping[TaskKind]>, error: Error): Promise<void> {
    const failedAt = new Date();

    if (task.retryCount >= this.config.taskHandlerMaxRetries) {
      // Task has exceeded max retries - move to DLQ or mark as failed
      if (this.datastore.addToDlq) {
        await this.datastore.addToDlq(task, error);
      } else {
        await this.datastore.fail(task.id);
      }

      this.emit(ProcessorEvents.TASK_FAILED, {
        task,
        error,
        failedAt,
      });

      // Schedule automatic redrive from DLQ after delay
      // This is bounded by maxDlqRetries in the datastore configuration
      // Tasks that exceed the DLQ retry limit will remain in DLQ permanently
      if (this.datastore.redriveFromDlq) {
        const redriveFn = this.datastore.redriveFromDlq.bind(this.datastore);
        const redriveDelayMs = 60_000; // 1 minute

        // Schedule redrive in background so we don't block the loop
        void (async () => {
          await setTimeout(redriveDelayMs);
          try {
            const result = await redriveFn<TaskKind>();
            const redrivenTasks = Array.isArray(result) ? result : [];
            redrivenTasks.forEach((t) => {
              this.emit(ProcessorEvents.TASK_RETRY_SCHEDULED, {
                task: t,
                error: null,
                errorAt: new Date(),
                retryScheduledAt: t.scheduledAt ?? new Date(),
              });
            });
          } catch (err) {
            this.emit(ProcessorEvents.UNKNOWN_PROCESSING_ERROR, { error: err, timestamp: new Date() });
          }
        })();
      }

      return;
    }

    // Schedule retry using backoff
    const delay = this.backOffStrategy({ retryAttempt: task.retryCount });
    const retryAt = new Date(Date.now() + delay);

    await this.datastore.retry(task.id, retryAt);
    this.emit(ProcessorEvents.TASK_RETRY_SCHEDULED, {
      task,
      error,
      errorAt: failedAt,
      retryScheduledAt: retryAt,
    });
  }
}