import { EventEmitter } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import type { BackoffStrategy } from '../backoff-strategy';
import type { BulkDatastore, RetryManyItem } from '../bulk-datastore';
import type { TaskMappingBase } from '../chrono';
import type { Datastore, Task } from '../datastore';
import { promiseWithTimeout } from '../utils/promise-utils';
import { ProcessorEvents, type ProcessorEventsMap } from './events';
import type { Processor } from './processor';

const DEFAULT_CONFIG: BulkProcessorConfiguration = {
  batchSize: 25,
  claimStaleTimeoutMs: 10_000,
  taskHandlerTimeoutMs: 5_000,
  taskHandlerMaxRetries: 5,
  batchIntervalMs: 5_000,
  processLoopRetryIntervalMs: 20_000,
};

export type BulkProcessorConfiguration = {
  /** The maximum number of tasks to claim per batch. @default 25 */
  batchSize: number;
  /** The maximum time a task can be claimed for processing before it will be considered stale and claimed again @default 10000ms */
  claimStaleTimeoutMs: number;
  /** The maximum time a task handler can take to complete before it will be considered timed out @default 5000ms */
  taskHandlerTimeoutMs: number;
  /** The maximum number of retries for a task handler, before task is marked as failed. @default 5 */
  taskHandlerMaxRetries: number;
  /** The interval to wait between each batch processing loop iteration @default 5000ms */
  batchIntervalMs: number;
  /** The interval at which the processor will wait before next poll when an unexpected error occurs @default 20000ms */
  processLoopRetryIntervalMs: number;
};

const InternalProcessorEvents = { PROCESSOR_LOOP_EXIT: 'processorLoopExit' } as const;

type InternalProcessorEventsMap = {
  [InternalProcessorEvents.PROCESSOR_LOOP_EXIT]: [];
};

type BulkDatastoreInstance<TaskMapping extends TaskMappingBase, DatastoreOptions> = Datastore<
  TaskMapping,
  DatastoreOptions
> &
  BulkDatastore<TaskMapping, DatastoreOptions>;

export class BulkProcessor<
    TaskKind extends Extract<keyof TaskMapping, string>,
    TaskMapping extends TaskMappingBase,
    DatastoreOptions,
  >
  extends EventEmitter<ProcessorEventsMap<TaskKind, TaskMapping>>
  implements Processor<TaskKind, TaskMapping>
{
  private config: BulkProcessorConfiguration;

  private exitChannel: EventEmitter<InternalProcessorEventsMap> | undefined;
  private loopDelayAbortController: AbortController | undefined;
  private stopRequested = false;

  constructor(
    private bulkDatastore: BulkDatastoreInstance<TaskMapping, DatastoreOptions>,
    private taskKind: TaskKind,
    private handler: (task: Task<TaskKind, TaskMapping[TaskKind]>) => Promise<void>,
    private backOffStrategy: BackoffStrategy,
    config?: Partial<BulkProcessorConfiguration>,
  ) {
    super();

    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    };

    this.validateConfiguration();
  }

  private validateConfiguration() {
    if (this.config.taskHandlerTimeoutMs >= this.config.claimStaleTimeoutMs) {
      throw new Error(
        `Task handler timeout (${this.config.taskHandlerTimeoutMs}ms) must be less than the claim stale timeout (${this.config.claimStaleTimeoutMs}ms)`,
      );
    }
  }

  async start(): Promise<void> {
    if (this.stopRequested || this.exitChannel) {
      return;
    }

    this.exitChannel = new EventEmitter<InternalProcessorEventsMap>();
    this.runProcessLoop(this.exitChannel);
  }

  async stop(): Promise<void> {
    if (!this.exitChannel) {
      return;
    }

    const exitPromise = new Promise((resolve) =>
      this.exitChannel?.once(InternalProcessorEvents.PROCESSOR_LOOP_EXIT, () => resolve(null)),
    );

    this.stopRequested = true;
    this.loopDelayAbortController?.abort();

    await exitPromise;
  }

  private async abortableDelay(ms: number): Promise<void> {
    if (this.stopRequested) {
      return;
    }

    const abortController = new AbortController();
    this.loopDelayAbortController = abortController;

    try {
      await setTimeout(ms, undefined, { signal: abortController.signal });
    } catch {
      // Delay aborted during stop.
    } finally {
      if (this.loopDelayAbortController === abortController) {
        this.loopDelayAbortController = undefined;
      }
    }
  }

  private async runProcessLoop(exitChannel: EventEmitter<InternalProcessorEventsMap>): Promise<void> {
    while (!this.stopRequested) {
      try {
        const tasks = await this.bulkDatastore.claimMany({
          kind: this.taskKind,
          batchSize: this.config.batchSize,
          claimStaleTimeoutMs: this.config.claimStaleTimeoutMs,
        });

        for (const task of tasks) {
          this.emit(ProcessorEvents.TASK_CLAIMED, { task, claimedAt: task.claimedAt || new Date() });
        }

        if (tasks.length > 0) {
          await this.processBatch(tasks);
        }

        await this.abortableDelay(this.config.batchIntervalMs);
      } catch (error) {
        this.emit(ProcessorEvents.UNKNOWN_PROCESSING_ERROR, { error, timestamp: new Date() });

        await this.abortableDelay(this.config.processLoopRetryIntervalMs);
      }
    }

    exitChannel.emit(InternalProcessorEvents.PROCESSOR_LOOP_EXIT);
  }

  private async processBatch(tasks: Task<TaskKind, TaskMapping[TaskKind]>[]) {
    const startedAt = new Date();
    const handlerResults = await Promise.allSettled(
      tasks.map((task) => promiseWithTimeout(this.handler(task), this.config.taskHandlerTimeoutMs)),
    );

    const completeIds: string[] = [];
    const retryItems: RetryManyItem[] = [];
    const failIds: string[] = [];
    const handlerErrors = new Map<string, unknown>();

    for (const [index, task] of tasks.entries()) {
      const handlerResult = handlerResults[index];

      if (handlerResult?.status === 'fulfilled') {
        completeIds.push(task.id);
        continue;
      }

      const error = handlerResult?.reason;
      handlerErrors.set(task.id, error);

      if (task.retryCount >= this.config.taskHandlerMaxRetries) {
        failIds.push(task.id);
        continue;
      }

      const delay = this.backOffStrategy({ retryAttempt: task.retryCount });
      retryItems.push({
        taskId: task.id,
        retryAt: new Date(Date.now() + delay),
      });
    }

    const completeResult =
      completeIds.length > 0
        ? await this.bulkDatastore.completeMany<TaskKind>(completeIds)
        : { succeeded: [], failed: [] };
    const retryResult =
      retryItems.length > 0 ? await this.bulkDatastore.retryMany<TaskKind>(retryItems) : { succeeded: [], failed: [] };
    const failResult =
      failIds.length > 0 ? await this.bulkDatastore.failMany<TaskKind>(failIds) : { succeeded: [], failed: [] };

    const retryAtByTaskId = new Map(retryItems.map((item) => [item.taskId, item.retryAt]));

    for (const task of completeResult.succeeded) {
      this.emit(ProcessorEvents.TASK_COMPLETED, {
        task,
        completedAt: task.completedAt || new Date(),
        startedAt,
      });
    }

    for (const failure of completeResult.failed) {
      const task = tasks.find((candidate) => candidate.id === failure.taskId);
      if (!task) {
        continue;
      }

      this.emit(ProcessorEvents.TASK_COMPLETION_FAILURE, {
        task,
        error: failure.error,
        failedAt: new Date(),
      });
    }

    for (const task of retryResult.succeeded) {
      const originalTask = tasks.find((candidate) => candidate.id === task.id);
      if (!originalTask) {
        continue;
      }

      this.emit(ProcessorEvents.TASK_RETRY_SCHEDULED, {
        task,
        error: handlerErrors.get(task.id),
        errorAt: startedAt,
        retryScheduledAt: retryAtByTaskId.get(task.id) || task.scheduledAt,
      });
    }

    for (const failure of retryResult.failed) {
      this.emit(ProcessorEvents.UNKNOWN_PROCESSING_ERROR, { error: failure.error, timestamp: new Date() });
    }

    for (const task of failResult.succeeded) {
      const originalTask = tasks.find((candidate) => candidate.id === task.id);
      if (!originalTask) {
        continue;
      }

      this.emit(ProcessorEvents.TASK_FAILED, {
        task,
        error: handlerErrors.get(task.id),
        failedAt: new Date(),
      });
    }

    for (const failure of failResult.failed) {
      this.emit(ProcessorEvents.UNKNOWN_PROCESSING_ERROR, { error: failure.error, timestamp: new Date() });
    }
  }
}
